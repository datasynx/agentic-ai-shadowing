import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShadowingDB } from './db.js';
import type { Anonymizer } from './anonymizer.js';
import type { ShadowingConfig, ExportResult, ExportManifest, ExportManifestSOP } from './types.js';
import { calculateSOPMetrics } from './metrics.js';
import { getExportsDir } from './config.js';

export class Exporter {
  private exportBaseDir: string;

  constructor(
    private db: ShadowingDB,
    private anonymizer: Anonymizer,
    private config: ShadowingConfig,
    exportBaseDir?: string,
  ) {
    this.exportBaseDir = exportBaseDir ?? getExportsDir();
  }

  exportSOPs(sopIds: string[]): ExportResult {
    if (sopIds.length === 0) throw new Error('Keine SOPs zum Exportieren ausgewählt.');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const exportDir = join(this.exportBaseDir, `export_${timestamp}`);
    const tmpDir = join(this.exportBaseDir, `.export_${timestamp}.tmp`);
    const sopsDir = join(tmpDir, 'sops');
    mkdirSync(sopsDir, { recursive: true });

    const manifestSOPs: ExportManifestSOP[] = [];
    const exportedSopIds: string[] = [];
    const allTags = new Set<string>();
    let totalDuration = 0;
    let totalExecutions = 0;
    let totalQuality = 0;

    for (let i = 0; i < sopIds.length; i++) {
      const sopId = sopIds[i]!;
      const sop = this.db.getSOP(sopId);
      if (!sop) continue;

      exportedSopIds.push(sopId);

      const tags = this.db.getTagsForSOP(sopId).map(t => t.name);
      tags.forEach(t => allTags.add(t));

      const metrics = calculateSOPMetrics(this.db, sopId, this.config.metrics.quality_score_weights);

      // Anonymize content
      const anonymizedContent = this.anonymizer.anonymize(sop.content_md);
      const anonymizedTitle = this.anonymizer.anonymize(sop.title);

      // Write SOP file
      const filename = `sop_${String(i + 1).padStart(3, '0')}.md`;
      writeFileSync(join(sopsDir, filename), anonymizedContent, 'utf8');

      // Mark SOP as exported
      this.db.updateSOPStatus(sopId, 'exported');

      manifestSOPs.push({
        file: filename,
        title: anonymizedTitle,
        tags,
        executions: metrics.execution_count,
        avg_duration_seconds: metrics.avg_duration_seconds,
        quality_score: metrics.overall_quality_score,
      });

      totalDuration += metrics.avg_duration_seconds;
      totalExecutions += metrics.execution_count;
      totalQuality += metrics.overall_quality_score;
    }

    const manifest: ExportManifest = {
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      source: 'agentic-ai-shadowing',
      sop_count: manifestSOPs.length,
      anonymized: true,
      tags_summary: [...allTags].sort(),
      metrics_summary: {
        avg_completion_time_seconds: manifestSOPs.length > 0
          ? Math.round(totalDuration / manifestSOPs.length) : 0,
        avg_quality_score: manifestSOPs.length > 0
          ? Math.round(totalQuality / manifestSOPs.length) : 0,
        total_executions: totalExecutions,
      },
      sops: manifestSOPs,
    };

    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // Atomic rename: tmp → final (prevents partial exports)
    renameSync(tmpDir, exportDir);

    // Log export in DB (only actually exported SOP IDs)
    this.db.logExport({
      sop_count: manifestSOPs.length,
      export_path: exportDir,
      sop_ids: exportedSopIds,
    });

    return {
      export_path: exportDir,
      sop_count: manifestSOPs.length,
      manifest,
    };
  }

  exportAll(): ExportResult {
    const approved = this.db.listSOPs({ status: 'approved' });
    if (approved.length === 0) throw new Error('Keine approved SOPs zum Exportieren vorhanden.');
    return this.exportSOPs(approved.map(s => s.id));
  }
}
