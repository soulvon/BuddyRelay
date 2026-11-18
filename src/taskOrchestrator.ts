import { AccountStore, CodeBuddyAccount } from './accountStore';
import { CheckinService } from './checkinService';
import { isCnAccount } from './domain';
import { GrowthAssetSummary, GrowthTask, GrowthTaskService } from './growthTaskService';
import { t } from './i18n';
import { formatAccountLabel, NotifyFn, SetOperatingFn } from './importExportService';

export interface TaskOrchestratorDeps {
  store: AccountStore;
  checkinService: CheckinService;
  growthTasks: GrowthTaskService;
  postMessage: (msg: any) => void;
  setOperating: SetOperatingFn;
  sendNotify: NotifyFn;
  postStateToWebview: () => void;
}

interface BatchDetailItem { accountName: string; status: 'ok' | 'fail' | 'skipped' | 'stopped'; message: string; }
interface BatchLoopStats { totalAccepted: number; totalClaimed: number; totalCredits: number; totalEnergy: number; totalSkipped: number; totalFailures: number; }

const BATCH_TEXT_KEYS = {
  auto: { op: 'msg.batchTaskRunning', start: 'prog.batchStart', abort: 'prog.aborted', step: 'prog.executing', err: 'prog.failWithReason', done: 'prog.batchFinished', stop: 'prog.batchStopped' },
  accept: { op: 'msg.batchAcceptRunning', start: 'prog.acceptStart', abort: 'prog.acceptAborted', step: 'prog.accepting', err: 'prog.acceptError', done: 'prog.acceptFinished', stop: 'prog.acceptStopped' }
} as const;

/**
 * 成长任务中心编排器：任务拉取、单任务报名/领奖、批量自动执行与余额回流。
 */
export class TaskOrchestrator {
  private deps: TaskOrchestratorDeps;
  private abortTaskBatch: boolean = false;

  constructor(deps: TaskOrchestratorDeps) {
    this.deps = deps;
  }

  public requestStop(): void {
    this.abortTaskBatch = true;
    this.deps.sendNotify('error', t('msg.stopRequested'));
  }

  private displayLabel(acc: CodeBuddyAccount): string {
    return formatAccountLabel(acc, this.deps.store.getPrivacyMode?.() ?? false);
  }

  private async cancellableSleep(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.abortTaskBatch) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private sendTaskProgress(text: string, level: 'doing' | 'ok' | 'fail', percent?: number, accountIndex?: number, totalAccounts?: number): void {
    this.deps.postMessage({
      command: 'taskProgress', text, level,
      percent: typeof percent === 'number' ? percent : undefined,
      accountIndex, totalAccounts
    });
  }

  private pushTasksToWebview(tasks: GrowthTask[], accountId?: string, accountName?: string, assetSummary?: GrowthAssetSummary): void {
    this.deps.postMessage({
      command: 'updateTasks',
      data: {
        accountId, accountName, assetSummary,
        tasks: tasks.map((task) => ({
          taskCode: task.taskCode, title: task.title, acceptStatus: task.acceptStatus,
          claimed: task.claimed, locked: task.locked, current: task.current, target: task.target,
          manualOnly: task.manualOnly, source: task.source
        }))
      }
    });
  }

  private async refreshAccountTasks(target: CodeBuddyAccount): Promise<void> {
    const [tasks, assetSummary] = await Promise.all([
      this.deps.growthTasks.listTasks(target),
      this.deps.growthTasks.getGrowthAssetSummary(target)
    ]);
    this.pushTasksToWebview(tasks, target.id, target.nickname || target.email, assetSummary);
  }

  private resolveCnTargets(accountIds?: string[] | null): CodeBuddyAccount[] {
    const targets: CodeBuddyAccount[] = [];
    if (accountIds && accountIds.length > 0) {
      for (const id of accountIds) {
        const acc = this.deps.store.get(id);
        if (acc) targets.push(acc);
      }
    } else {
      const active = this.deps.store.getActive();
      if (active) targets.push(active);
    }
    const cnTargets = targets.filter((acc) => isCnAccount(acc.domain));
    if (cnTargets.length < targets.length) {
      this.deps.sendNotify('warn', t('intl.cnOnlyDetail'));
    }
    return cnTargets;
  }

  public async syncBalancesAfterTasks(targets: CodeBuddyAccount[]): Promise<void> {
    if (!targets.length) return;
    await Promise.all(
      targets.map((acc) => this.deps.checkinService.syncAccountStatus(acc, this.deps.store).catch(() => {}))
    );
    this.deps.postStateToWebview();
  }

  public async handleTaskList(accountId?: string): Promise<void> {
    const target = (accountId ? this.deps.store.get(accountId) : undefined)
      || this.deps.store.getActive()
      || this.deps.store.getAll()[0];
    if (!target) {
      this.deps.sendNotify('error', t('msg.poolEmpty'));
      return;
    }

    this.deps.setOperating(true, t('msg.readingTasksFor', this.displayLabel(target)));
    try {
      const sourceErrors: string[] = [];
      const [tasks, assetSummary] = await Promise.all([
        this.deps.growthTasks.listTasks(target, sourceErrors),
        this.deps.growthTasks.getGrowthAssetSummary(target)
      ]);
      if (tasks.length === 0 && sourceErrors.length > 0) {
        this.deps.sendNotify('error', t('err.readTasksFailed', sourceErrors.join(' | ')));
      }
      this.pushTasksToWebview(tasks, target.id, target.nickname || target.email, assetSummary);
    } catch (err: any) {
      this.deps.sendNotify('error', t('err.readTasksFailed', err?.message || String(err)));
    } finally {
      this.deps.setOperating(false);
    }
  }

  public async handleTaskAcceptSingle(accountId: string, taskCode: string): Promise<void> {
    const target = accountId ? this.deps.store.get(accountId) : this.deps.store.getActive();
    if (!target) { this.deps.sendNotify('error', t('err.targetMissing')); return; }
    if (!isCnAccount(target.domain)) { this.deps.sendNotify('warn', t('intl.cnOnlyDetail')); return; }
    const cleanCode = String(taskCode || '').trim();
    if (!cleanCode) return;

    try {
      const res = await this.deps.growthTasks.acceptSingleTask(target, cleanCode);
      this.deps.sendNotify(
        res.success ? 'success' : 'error',
        res.success
          ? t('js.taskAcceptSingleDone', res.message || cleanCode)
          : t('js.taskAcceptSingleFail', res.message || t('err.unknownError'))
      );
      await this.refreshAccountTasks(target);
      await this.syncBalancesAfterTasks([target]);
    } catch (err: any) {
      this.deps.sendNotify('error', t('js.taskAcceptSingleFail', err?.message || String(err)));
    }
  }

  public async handleTaskClaim(taskCode: string, accountId?: string): Promise<void> {
    const target = accountId ? this.deps.store.get(accountId) : this.deps.store.getActive();
    if (!target) { this.deps.sendNotify('error', t('err.noClaimTarget')); return; }

    const label = this.displayLabel(target);
    try {
      const r = await this.deps.growthTasks.claimTask(target, taskCode);
      if (r.ok && !r.already) this.deps.sendNotify('success', t('msg.claimOk', label, r.credit, r.energy));
      else if (r.already) this.deps.sendNotify('error', t('msg.claimAlready', label));
      else this.deps.sendNotify('error', t('err.claimNotMet', label) + (r.detail ? ` (${r.detail})` : ''));
      await this.refreshAccountTasks(target);
      if (r.ok && !r.already) await this.syncBalancesAfterTasks([target]);
    } catch (err: any) {
      this.deps.sendNotify('error', t('err.claimFailed', err?.message || String(err)));
    }
  }

  private async runBatchLoop(
    mode: 'auto' | 'accept',
    accountIds: string[] | null | undefined,
    executeOne: (acc: CodeBuddyAccount, stats: BatchLoopStats) => Promise<{ status: 'ok' | 'fail' | 'skipped'; level: 'doing' | 'ok' | 'fail'; message: string }>,
    notifyDone: (processed: number, total: number, stats: BatchLoopStats) => void
  ): Promise<void> {
    this.abortTaskBatch = false;
    const keys = BATCH_TEXT_KEYS[mode];
    const startTime = Date.now();
    const targets = this.resolveCnTargets(accountIds);
    if (targets.length === 0) { this.deps.sendNotify('error', t('err.noAccountsToRun')); return; }

    this.deps.setOperating(true, t(keys.op, targets.length));
    const stats: BatchLoopStats = { totalAccepted: 0, totalClaimed: 0, totalCredits: 0, totalEnergy: 0, totalSkipped: 0, totalFailures: 0 };
    let processedAccounts = 0;
    let wasStopped = false;
    const details: BatchDetailItem[] = [];

    this.sendTaskProgress(t(keys.start, targets.length), 'doing', 0, 0, targets.length);
    try {
      for (let i = 0; i < targets.length; i++) {
        const acc = targets[i];
        const rawName = acc.nickname || acc.email;
        const safeLabel = this.displayLabel(acc);
        if (this.abortTaskBatch) {
          wasStopped = true;
          this.sendTaskProgress(t(keys.abort), 'fail', Math.round((i / targets.length) * 100), i, targets.length);
          details.push({ accountName: rawName, status: 'stopped', message: t('prog.stoppedByUser') });
          break;
        }
        const pct = Math.round((i / targets.length) * 100);
        const donePct = Math.round(((i + 1) / targets.length) * 100);
        this.sendTaskProgress(`[${i + 1}/${targets.length}] ${safeLabel}: ${t(keys.step)}`, 'doing', pct, i + 1, targets.length);
        try {
          const outcome = await executeOne(acc, stats);
          processedAccounts++;
          this.sendTaskProgress(`[${i + 1}/${targets.length}] ${safeLabel}: ${outcome.message}`, outcome.level, donePct, i + 1, targets.length);
          details.push({ accountName: rawName, status: outcome.status, message: outcome.message });
        } catch (err: any) {
          processedAccounts++;
          stats.totalFailures++;
          const errMsg = err?.message || String(err);
          this.sendTaskProgress(`[${i + 1}/${targets.length}] ${safeLabel}: ${t(keys.err, errMsg)}`, 'fail', donePct, i + 1, targets.length);
          details.push({ accountName: rawName, status: 'fail', message: errMsg });
        }
        if (i < targets.length - 1 && !this.abortTaskBatch) await this.cancellableSleep(Math.round((3 + Math.random() * 5) * 1000));
      }

      const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      this.sendTaskProgress(wasStopped ? t(keys.stop) : t(keys.done), wasStopped ? 'fail' : 'ok', 100, targets.length, targets.length);
      this.deps.postMessage({
        command: 'taskBatchSummary',
        data: { mode, totalAccounts: targets.length, processedAccounts, stopped: wasStopped, durationSec, ...stats, details }
      });
      notifyDone(processedAccounts, targets.length, stats);
      const primary = targets[0] || this.deps.store.getActive();
      if (primary) await this.refreshAccountTasks(primary);
      await this.syncBalancesAfterTasks(targets);
    } finally {
      this.deps.setOperating(false);
    }
  }

  public async handleTaskRunAuto(accountIds?: string[] | null): Promise<void> {
    await this.runBatchLoop('auto', accountIds, async (acc, stats) => {
      const r = await this.deps.growthTasks.runAutoComplete(acc);
      stats.totalClaimed += r.claimed; stats.totalCredits += r.claimedCredits; stats.totalEnergy += r.claimedEnergy;
      stats.totalAccepted += r.accepted; stats.totalSkipped += r.skipped.length; stats.totalFailures += r.failures.length;

      if (r.failures.some((f) => f.includes('11140') || f.toLowerCase().includes('request illegal'))) {
        return { status: 'fail', level: 'fail', message: t('prog.accountRestricted') + ': ' + t('err.restrictedDetail') };
      }
      const parts = [
        r.buddyAdopted ? t('act.buddyAdopted') : '',
        r.accepted > 0 ? t('act.acceptedN', r.accepted) : '',
        r.claimed > 0 ? t('act.claimedN', r.claimed, r.claimedCredits) : '',
        r.travelClaimed ? t('act.travelGift') : '',
        r.travelDeparted ? t('act.travelDeparted', r.travelLocation || t('act.travelDefault')) : '',
        r.streakRedeemedCredits > 0 ? t('act.streakRedeemed', r.streakRedeemedCredits) : '',
        r.madeUpDays > 0 ? t('act.madeUpDays', r.madeUpDays) : '',
        r.buddyBoxesOpened > 0 ? t('act.boxOpened', r.newBuddyName || t('act.newBuddy')) : '',
        r.lotteryDraws > 0 ? t('act.lotteryN', r.lotteryDraws) : ''
      ].filter(Boolean);

      if (parts.length > 0) return { status: 'ok', level: 'ok', message: parts.join('，') };
      if (r.failures.length > 0) return { status: 'fail', level: 'fail', message: t('err.taskExecuteAbnormal', r.failures.join('; ')) };
      return { status: 'skipped', level: 'doing', message: t('msg.noClaimable', r.inProgressTasks, r.skipped.length) };
    }, (processed, total, s) => this.deps.sendNotify(
      s.totalClaimed > 0 || s.totalAccepted > 0 ? 'success' : 'error',
      t('msg.batchTaskDone', processed, total, s.totalClaimed, s.totalCredits)
    ));
  }

  public async handleTaskAcceptAll(accountIds?: string[] | null): Promise<void> {
    await this.runBatchLoop('accept', accountIds, async (acc, stats) => {
      const tasks = await this.deps.growthTasks.listTasks(acc);
      const res = await this.deps.growthTasks.acceptAll(acc, tasks);
      stats.totalAccepted += res.accepted; stats.totalFailures += res.failed;
      if (res.failed > 0) {
        const msg = res.accepted > 0 ? t('msg.acceptPartial', res.accepted, res.failed, res.failures.join('; ')) : t('err.acceptFailed', res.failures.join('; '));
        return { status: 'fail', level: 'fail', message: msg };
      }
      const okMsg = res.accepted > 0 ? t('msg.acceptedN', res.accepted) : (res.alreadyAccepted > 0 ? t('msg.nothingToAccept') : t('msg.noTasksToAccept'));
      return { status: 'ok', level: res.accepted > 0 ? 'ok' : 'doing', message: okMsg };
    }, (_processed, _total, s) => this.deps.sendNotify(
      s.totalAccepted > 0 ? 'success' : (s.totalFailures > 0 ? 'error' : 'success'),
      t('msg.batchAcceptDone', s.totalAccepted) + (s.totalFailures > 0 ? t('msg.batchAcceptDoneFail', s.totalFailures) : '')
    ));
  }
}
