import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { readRunDiagnostics } from '@/adapters/sqlite/run-diagnostics-repository';
import { getSettingsVersionById } from '@/adapters/sqlite/settings-repository';
import { sanitizePathParam, maskSensitiveInfo, SecurityError } from '@/contracts/security';

// Kept local so loading this GET route never imports the calculation pipeline or seed parser.
const SEED_SCHEDULE_VERSION_ID = 'seed-v250922';
const DIAGNOSTIC_UNAVAILABLE_MESSAGE = '此歷史 run 未保存可驗證的診斷版本與內容，無法提供原始診斷。';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId: rawRunId } = await context.params;
    const runId = sanitizePathParam(rawRunId, 'runId');
    const url = new URL(request.url);
    const againstRuleSet = url.searchParams.get('againstRuleSet');

    if (!againstRuleSet) {
      return NextResponse.json({ error: '缺少必要參數 againstRuleSet' }, { status: 400 });
    }
    if (againstRuleSet !== 'excel-v260922-compat') {
      return NextResponse.json(
        { error: `againstRuleSet 僅支援 'excel-v260922-compat'，不支援: ${againstRuleSet}` },
        { status: 400 }
      );
    }

    const db = getDatabase();
    const run = getCalculationRun(db, runId);
    if (!run) return NextResponse.json({ error: `找不到 run: ${runId}` }, { status: 404 });

    // Preserve UX38's missing-settings snapshot contract without decoding it with today's parser.
    if (run.scheduleVersionId !== SEED_SCHEDULE_VERSION_ID && !getSettingsVersionById(db, run.scheduleVersionId)) {
      return NextResponse.json({
        error: `找不到該 run 當時的課表快照（版本 ${run.scheduleVersionId}）：資料不足，無法提供診斷。`,
        code: 'SNAPSHOT_UNAVAILABLE',
      }, { status: 409 });
    }

    const diagnostic = readRunDiagnostics(db, run);
    if (diagnostic.status === 'version-unavailable' || diagnostic.status === 'content-missing') {
      return NextResponse.json({ error: DIAGNOSTIC_UNAVAILABLE_MESSAGE, code: 'DIAGNOSTIC_VERSION_UNAVAILABLE' }, { status: 409 });
    }
    if (diagnostic.status === 'corrupted') {
      return NextResponse.json({
        error: '此 run 的診斷快照內容無效，無法安全提供。',
        code: 'DIAGNOSTIC_SNAPSHOT_CORRUPTED',
      }, { status: 500 });
    }

    return NextResponse.json({
      runId,
      diagnosticAlgorithmVersion: diagnostic.diagnosticAlgorithmVersion,
      totalDifferences: diagnostic.totalDifferences,
      differences: diagnostic.differences,
    });
  } catch (error) {
    if (error instanceof SecurityError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: maskSensitiveInfo(message) }, { status: 500 });
  }
}
