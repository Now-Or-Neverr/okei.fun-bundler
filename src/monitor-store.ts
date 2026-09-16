import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

import type {LaunchMonitorReport} from './monitor.js';

const DEFAULT_DIR = path.join(process.cwd(), 'data', 'monitor');

export function monitorDir(): string {
  return process.env.BUNDLER_MONITOR_DIR?.trim() || DEFAULT_DIR;
}

export async function saveLaunchReport(report: LaunchMonitorReport): Promise<string> {
  const dir = monitorDir();
  await mkdir(dir, {recursive: true});
  const file = path.join(dir, `${report.id}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

export async function listLaunchReports(limit = 50): Promise<LaunchMonitorReport[]> {
  const dir = monitorDir();
  try {
    const files = await readdir(dir);
    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().reverse();
    const slice = jsonFiles.slice(0, limit);
    const reports: LaunchMonitorReport[] = [];
    for (const f of slice) {
      try {
        const raw = await readFile(path.join(dir, f), 'utf8');
        reports.push(JSON.parse(raw) as LaunchMonitorReport);
      } catch {
        /* skip corrupt */
      }
    }
    return reports;
  } catch {
    return [];
  }
}

export async function getLaunchReport(id: string): Promise<LaunchMonitorReport | undefined> {
  const file = path.join(monitorDir(), `${id}.json`);
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as LaunchMonitorReport;
  } catch {
    return undefined;
  }
}
