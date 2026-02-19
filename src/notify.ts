import notifier from 'node-notifier';

export class NotificationService {
  constructor(private enabled: boolean) {}

  nodeDiscovered(nodeId: string, via: string): void {
    this.send(`📍 Node entdeckt: ${nodeId}`, `Via: ${via}`);
  }

  workflowDetected(count: number, desc: string): void {
    this.send(`🔄 ${count} Workflow(s) erkannt`, desc);
  }

  taskBoundary(gapMinutes: number): void {
    this.send('⏸ Task-Grenze erkannt', `${gapMinutes} Minuten Inaktivität`);
  }

  private send(title: string, message: string): void {
    if (!this.enabled) return;

    try {
      notifier.notify({ title, message, sound: false });
    } catch {
      // Notifications not available — silently skip
    }
  }
}
