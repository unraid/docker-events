import { watch, FSWatcher } from 'fs';
import { EventEmitter } from 'events';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import debug from 'debug';

const log = debug('docker-events');

export class DockerEventEmitter extends EventEmitter {
  #cmd: ChildProcessWithoutNullStreams;
  #watcher: FSWatcher;
  #data: string;
  #lastSeen: string;
  #filters: string[];

  constructor(filters: string[] = []) {
    super();

    this.#cmd = null;
    this.#data = '';
    this.#filters = filters;
  }

  emit(type: string, ...args: any[]) {
    super.emit('*', ...args);
    return super.emit(type, ...args) || super.emit('', ...args);
  }

  private cleanup() {
    // If there's a listener spawned kill it
    if (this.#cmd) {
      // Bail if it's been killed already
      if (this.#cmd.killed) return;
      // Kill listener
      this.#cmd.kill();
    }
  }

  listen() {
    // Cleanup last "listen" call
    this.cleanup();

    // Watch to see if the docker socket is deleted
    // If so stop the spawned process and wait
    // Once the socket exists again rerun `this.listen()`
    if (!this.#watcher) {
      this.#watcher = watch('/var/run', (event, filename) => {

        // Only react to rename events
        if (event !== 'rename') return;

        // Only react our two filenames
        if (filename !== 'docker.sock' && filename !== 'dockerd.pid') return;

        // Docker socket was deleted
        if (this.#lastSeen === 'docker.sock' && filename === 'dockerd.pid') {
          this.cleanup();
        }

        // Docker socket was created
        if (this.#lastSeen === 'dockerd.pid' && filename === 'docker.sock') {
          this.listen();
        }

        // Update for the next rename event
        this.#lastSeen = filename;
      });
    }

    log('spawning docker events');

    // Create filters string for events
    const filters = this.#filters.map(filter => `--filter ${filter}`).join(' ');

    // Span child process to listen to events
    this.#cmd = spawn(`docker events --format '{{json .}}' ${filters}`, { shell: true });

    // Kill child process on exit
    process.on('exit', () => {
      this.#cmd.kill();
    });

    this.#cmd.stdout.setEncoding('utf8');

    this.#cmd.on('error', (error: Error) => {
      log('failed to start command, error: %s', error);
      this.emit('error', error);
    });

    this.#cmd.stdout.on('data', data => this.tryParseStdoutData(data));
  }

  private tryParseStdoutData(data) {
    if (!data) return;

    /*
     * If there is a newline, assume this is multiple JSON lines,
     * separate them, and try to parse them individually
     */
    const strings = data.split(/\n/);
    if (strings.length > 1) {
      strings.forEach((string: string) => {
        this.tryParseStdoutData(string);
      });
    } else {
      this.#data = `${this.#data}${data.toString()}`;
      try {
        const json = JSON.parse(this.#data);
        this.#data = '';
        const eventType = json.Action;

        log('emitting docker-event %j', json);
        this.emit(eventType, json);
      } catch (err) {
        log(err, data);
      }
    }
  }
}

export default new DockerEventEmitter();
