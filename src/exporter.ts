import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShadowingDB } from './db.js';
import { Anonymizer, type RedactionSummary } from './anonymizer.js';
import type { ShadowingConfig, ExportResult, ExportManifest, ExportManifestSOP } from './types.js';
import { calculateSOPMetrics } from './metrics.js';
import { getExportsDir } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('exporter');

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
    if (sopIds.length === 0) throw new Error('No SOPs selected for export.');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
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

    // Aggregate redaction summary
    const totalRedaction: RedactionSummary = {
      email_count: 0, ip_count: 0, url_count: 0, phone_count: 0,
      filepath_count: 0, iban_count: 0, credit_card_count: 0, custom_count: 0,
      secret_count: 0, high_entropy_count: 0, ssn_count: 0, credential_count: 0,
    };

    for (let i = 0; i < sopIds.length; i++) {
      const sopId = sopIds[i]!;
      const sop = this.db.getSOP(sopId);
      if (!sop) continue;

      exportedSopIds.push(sopId);

      const tags = this.db.getTagsForSOP(sopId).map(t => t.name);
      tags.forEach(t => allTags.add(t));

      const metrics = calculateSOPMetrics(this.db, sopId, this.config.metrics.quality_score_weights);

      // Anonymize content with summary tracking
      const contentResult = this.anonymizer.anonymizeWithSummary(sop.content_md);
      const titleResult = this.anonymizer.anonymizeWithSummary(sop.title);

      // Aggregate redaction counts
      for (const key of Object.keys(totalRedaction) as (keyof RedactionSummary)[]) {
        totalRedaction[key] += contentResult.summary[key] + titleResult.summary[key];
      }

      // Write SOP file
      const filename = `sop_${String(i + 1).padStart(3, '0')}.md`;
      writeFileSync(join(sopsDir, filename), contentResult.text, 'utf8');

      // Mark SOP as exported
      this.db.updateSOPStatus(sopId, 'exported');

      manifestSOPs.push({
        file: filename,
        title: titleResult.text,
        tags,
        executions: metrics.execution_count,
        avg_duration_seconds: metrics.avg_duration_seconds,
        quality_score: metrics.overall_quality_score,
      });

      totalDuration += metrics.avg_duration_seconds;
      totalExecutions += metrics.execution_count;
      totalQuality += metrics.overall_quality_score;
    }

    // Log redaction summary for compliance
    log.info('PII redaction completed for export', {
      sop_count: manifestSOPs.length,
      ...totalRedaction,
    });

    const manifest: ExportManifest = {
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      source: 'agentic-ai-shadowing',
      sop_count: manifestSOPs.length,
      anonymized: true,
      tags_summary: [...allTags].sort(),
      redaction_summary: totalRedaction,
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
    let finalDir = exportDir;
    if (existsSync(exportDir)) {
      let counter = 1;
      while (existsSync(`${exportDir}_${counter}`)) counter++;
      finalDir = `${exportDir}_${counter}`;
    }
    renameSync(tmpDir, finalDir);

    // Log export in DB
    this.db.logExport({
      sop_count: manifestSOPs.length,
      export_path: finalDir,
      sop_ids: exportedSopIds,
    });

    return {
      export_path: finalDir,
      sop_count: manifestSOPs.length,
      manifest,
    };
  }

  exportAll(): ExportResult {
    const approved = this.db.listSOPs({ status: 'approved' });
    if (approved.length === 0) throw new Error('No approved SOPs available for export.');
    return this.exportSOPs(approved.map(s => s.id));
  }
}
