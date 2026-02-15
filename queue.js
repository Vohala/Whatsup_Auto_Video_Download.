const EventEmitter = require("events");

class JobQueue extends EventEmitter {
  constructor(maxConcurrent = 1) {
    super();
    this.maxConcurrent = maxConcurrent;
    this.queue = [];
    this.active = 0;
  }

  add(job) {
    this.queue.push(job);
    this.process();
  }

  async process() {
    if (this.active >= this.maxConcurrent) return;
    const job = this.queue.shift();
    if (!job) return;

    this.active++;
    this.emit("job-start", job.id);

    try {
      await job.run();
      this.emit("job-success", job.id);
    } catch (err) {
      this.emit("job-error", job.id, err);
    } finally {
      this.active--;
      this.emit("job-finish", job.id);
      if (this.queue.length > 0) {
        setImmediate(() => this.process());
      }
    }
  }

  getSnapshot() {
    return {
      active: this.active,
      queued: this.queue.length
    };
  }
}

module.exports = JobQueue;
