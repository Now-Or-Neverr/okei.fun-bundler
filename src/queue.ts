import {randomUUID} from 'node:crypto';

import type {LaunchRequest, LaunchResult} from './launch.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type LaunchJob = {
  id: string;
  status: JobStatus;
  request: LaunchRequest;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: LaunchResult;
  error?: string;
};

export class LaunchQueue {
  private jobs = new Map<string, LaunchJob>();
  private order: string[] = [];
  private running = false;

  enqueue(request: LaunchRequest): LaunchJob {
    const id = randomUUID();
    const job: LaunchJob = {
      id,
      status: 'queued',
      request,
      createdAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.order.push(id);
    return job;
  }

  enqueueMany(requests: LaunchRequest[]): LaunchJob[] {
    return requests.map((r) => this.enqueue(r));
  }

  get(id: string): LaunchJob | undefined {
    return this.jobs.get(id);
  }

  list(): LaunchJob[] {
    return this.order.map((id) => this.jobs.get(id)!).filter(Boolean);
  }

  /** Process one job at a time (bundle = ordered sequence, not one tx). */
  async runWorker(runOne: (req: LaunchRequest) => Promise<LaunchResult>, gapMs = 2000) {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const nextId = this.order.find((id) => this.jobs.get(id)?.status === 'queued');
        if (!nextId) break;
        const job = this.jobs.get(nextId)!;
        job.status = 'running';
        job.startedAt = Date.now();
        try {
          job.result = await runOne(job.request);
          job.status = 'done';
        } catch (e) {
          job.status = 'failed';
          job.error = e instanceof Error ? e.message : String(e);
        }
        job.finishedAt = Date.now();
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      }
    } finally {
      this.running = false;
    }
  }

  get runningWorker() {
    return this.running;
  }
}
