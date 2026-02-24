import type { ShadowingDB } from './db.js';
import type { Task } from './types.js';

export class TaskManager {
  constructor(private db: ShadowingDB) {}

  startTask(title: string, description?: string): Task {
    const active = this.db.getActiveTask();
    if (active) {
      throw new Error(
        `Es läuft bereits ein Task: "${active.title}" (ID: ${active.id.substring(0, 8)}). ` +
        `Schließe oder breche ihn zuerst ab.`
      );
    }
    return this.db.createTask(title, description);
  }

  getActiveTask(): Task | null {
    return this.db.getActiveTask();
  }

  pauseTask(): Task {
    const active = this.db.getActiveTask();
    if (!active) throw new Error('Kein aktiver Task zum Pausieren.');
    return this.db.pauseTask(active.id);
  }

  resumeTask(id?: string): Task {
    if (id) {
      const task = this.db.getTask(id);
      if (!task) throw new Error(`Task ${id} nicht gefunden.`);
      if (task.status !== 'paused') throw new Error(`Task "${task.title}" ist nicht pausiert.`);
      return this.db.resumeTask(task.id);
    }
    // Resume the most recent paused task
    const paused = this.db.listTasks({ status: 'paused' });
    if (paused.length === 0) throw new Error('Kein pausierter Task zum Fortsetzen.');
    return this.db.resumeTask(paused[0]!.id);
  }

  completeTask(complexityRating?: number): { task: Task; duration: string } {
    const active = this.db.getActiveTask();
    if (!active) throw new Error('Kein aktiver Task zum Abschließen.');

    const task = this.db.completeTask(active.id);

    // Log execution on all SOPs linked to this task
    const sops = this.db.listSOPs().filter(s => s.task_id === task.id);
    for (const sop of sops) {
      if (task.duration_seconds) {
        this.db.logExecution(sop.id, {
          duration_seconds: task.duration_seconds,
          complexity_rating: complexityRating,
        });
      }
    }

    return {
      task,
      duration: formatDuration(task.duration_seconds ?? 0),
    };
  }

  cancelTask(): Task {
    const active = this.db.getActiveTask();
    if (!active) throw new Error('Kein aktiver Task zum Abbrechen.');
    return this.db.cancelTask(active.id);
  }

  addNote(note: string): Task {
    const active = this.db.getActiveTask();
    if (!active) throw new Error('Kein aktiver Task für Notizen.');

    const existing = active.description ?? '';
    const updated = existing ? `${existing}\n- ${note}` : `- ${note}`;
    return this.db.updateTask(active.id, { description: updated });
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}min`);
  if (secs > 0 && hours === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}
