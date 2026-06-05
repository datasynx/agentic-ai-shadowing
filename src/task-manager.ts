import type { ShadowingDB } from './db.js';
import type { Task } from './types.js';
import { ShadowingError } from './errors.js';

export class TaskManager {
  constructor(private db: ShadowingDB) {}

  startTask(title: string, description?: string): Task {
    const active = this.db.getActiveTask();
    if (active) {
      throw new ShadowingError(
        `A task is already running: "${active.title}" (ID: ${active.id.substring(0, 8)}). Complete or cancel it first.`,
        'task_already_active',
        { activeTaskId: active.id, activeTaskTitle: active.title },
      );
    }
    return this.db.createTask(title, description);
  }

  getActiveTask(): Task | null {
    return this.db.getActiveTask();
  }

  pauseTask(): Task {
    const active = this.db.getActiveTask();
    if (!active) throw new ShadowingError('No active task to pause.', 'no_active_task');
    return this.db.pauseTask(active.id);
  }

  resumeTask(id?: string): Task {
    if (id) {
      const task = this.db.getTask(id);
      if (!task) throw new ShadowingError(`Task ${id} not found.`, 'task_not_found', { taskId: id });
      if (task.status !== 'paused') throw new ShadowingError(`Task "${task.title}" is not paused.`, 'task_not_paused', { taskId: id, status: task.status });
      return this.db.resumeTask(task.id);
    }
    const paused = this.db.listTasks({ status: 'paused' });
    if (paused.length === 0) throw new ShadowingError('No paused task to resume.', 'no_paused_task');
    return this.db.resumeTask(paused[0]!.id);
  }

  completeTask(complexityRating?: number): { task: Task; duration: string } {
    const active = this.db.getActiveTask();
    if (!active) throw new ShadowingError('No active task to complete.', 'no_active_task');

    const task = this.db.completeTask(active.id);

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
    if (!active) throw new ShadowingError('No active task to cancel.', 'no_active_task');
    return this.db.cancelTask(active.id);
  }

  addNote(note: string): Task {
    const active = this.db.getActiveTask();
    if (!active) throw new ShadowingError('No active task for notes.', 'no_active_task');

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
  if (secs > 0) parts.push(`${secs}s`);

  return parts.join(' ');
}
