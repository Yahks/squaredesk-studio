import { useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Send,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import type { Account, AutomationJob, Draft, Persona, PublishLog } from '../types';
import { DraftStatusLabel } from './StatusText';

interface AutomationPublishViewProps {
  drafts: Draft[];
  personas: Persona[];
  accounts: Account[];
  jobs: AutomationJob[];
  publishLogs: PublishLog[];
  onRefresh: () => Promise<void>;
  onOpenChallenge: (jobId: string) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export function AutomationPublishView({
  drafts,
  personas,
  accounts,
  jobs,
  publishLogs,
  onRefresh,
  onOpenChallenge,
  onNotify,
}: AutomationPublishViewProps) {
  const [expandedJobId, setExpandedJobId] = useState<string>(jobs[0]?.id || '');
  const [publishingId, setPublishingId] = useState<string>('');

  const scheduledAndApproved = drafts.filter(
    (d) => d.status === 'scheduled' || d.status === 'approved' || d.status === 'publishing'
  );

  const handlePublishNow = async (draftId: string) => {
    setPublishingId(draftId);
    try {
      const res = await api.publishDraft(draftId);
      await onRefresh();
      const viaLabel =
        res.method === 'square_openapi' ? 'Binance Creator OpenAPI' : 'Playwright';
      onNotify(`Launched ${viaLabel} publish job ${res.jobId} for ${draftId}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to start publish job', 'error');
    } finally {
      setPublishingId('');
    }
  };

  const renderJobStatus = (status: AutomationJob['status']) => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Completed
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 whitespace-nowrap shrink-0">
            <XCircle className="h-3.5 w-3.5" />
            Failed
          </span>
        );
      case 'awaiting_mfa':
      case 'awaiting_captcha':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0">
            <ShieldAlert className="h-3.5 w-3.5" />
            {status === 'awaiting_mfa' ? 'Needs 6-Digit MFA' : 'Needs CAPTCHA'}
          </span>
        );
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#F0B90B] whitespace-nowrap shrink-0">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Running
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap shrink-0">
            <AlertTriangle className="h-3.5 w-3.5" />
            Queued
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Staggered Daily Schedule Matrix */}
      <section className="rounded-lg border border-white/10 bg-[#12161F] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#EAECEF]">
              Staggered Persona Schedule & Dispatch Queue
            </h2>
            <p className="text-xs text-slate-400">
              Publisher personas dispatch via Binance Square Creator OpenAPI when a Creator key is saved, or fall back to isolated Chromium login when no key is configured.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-400 tabular-nums">
            {scheduledAndApproved.length} queued
          </span>
        </div>

        {/* Persona Active Hours Strip */}
        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-white/10 border-b border-white/10 bg-[#0E121A]">
          {personas.map((p) => {
            const acc = accounts.find((a) => a.id === p.account_id);
            const queuedCount = scheduledAndApproved.filter((d) => d.persona_id === p.id).length;
            return (
              <div key={p.id} className="p-4 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#EAECEF]">{p.display_name}</span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {queuedCount} ready
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Account: {acc?.label || 'Unlinked'} · {p.posting_frequency}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <CalendarClock className="h-3.5 w-3.5 text-[#F0B90B]" />
                  {p.active_hours.map((hr) => (
                    <span
                      key={hr}
                      className="rounded border border-white/10 bg-[#12161F] px-2 py-0.5 font-mono text-[11px] text-slate-300"
                    >
                      {hr}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Queued & Approved Drafts Table */}
        {scheduledAndApproved.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No approved or scheduled drafts in queue. Approve articles in Human Review to dispatch them here.
          </div>
        ) : (
          <div className="divide-y divide-white/[0.07]">
            {scheduledAndApproved.map((d) => {
              const persona = personas.find((p) => p.id === d.persona_id);
              const linkedAcc = accounts.find((a) => a.id === persona?.account_id);
              const isBusy = publishingId === d.id || d.status === 'publishing';
              return (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-6 py-3.5 hover:bg-white/[0.02]"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono text-[#F0B90B]">{d.id}</span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="font-medium text-[#EAECEF]">{persona?.display_name || d.persona_id}</span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <DraftStatusLabel status={d.status} />
                    </div>
                    <p className="text-sm text-slate-200 truncate">{d.title}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {d.scheduled_for
                        ? `Scheduled for: ${new Date(d.scheduled_for).toLocaleString()}`
                        : 'Approved (Manual or immediate dispatch)'}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handlePublishNow(d.id)}
                    className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {linkedAcc?.has_square_api_key
                      ? 'Dispatch via Creator API'
                      : 'Dispatch via Browser'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 2: Live Playwright Automation Jobs & Challenge Resolver */}
      <section className="rounded-lg border border-white/10 bg-[#12161F] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#EAECEF]">
              Playwright Automation Jobs (Scrape, Auth & Publish)
            </h2>
            <p className="text-xs text-slate-400">
              Automatic browser execution across isolated profiles. Pauses only for 6-digit email verification or CAPTCHA intervention.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-500 tabular-nums">{jobs.length} recent</span>
        </div>

        {jobs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No automation jobs executed yet.
          </div>
        ) : (
          <div className="divide-y divide-white/[0.07]">
            {jobs.map((job) => {
              const acc = accounts.find((a) => a.id === job.account_id);
              const isExpanded = expandedJobId === job.id;
              const needsAction =
                job.status === 'awaiting_mfa' || job.status === 'awaiting_captcha';

              return (
                <div key={job.id} className="bg-[#12161F]">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 hover:bg-white/[0.02]">
                    <button
                      type="button"
                      onClick={() => setExpandedJobId(isExpanded ? '' : job.id)}
                      className="flex items-center gap-3 text-left min-w-0"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono text-slate-200">{job.id}</span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span className="uppercase font-mono text-[11px] text-[#F0B90B]">
                            {job.job_type}
                          </span>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span className="text-slate-300">{acc?.label || job.account_id}</span>
                          {job.draft_id && (
                            <>
                              <span aria-hidden="true" className="text-slate-600">·</span>
                              <span className="font-mono text-slate-400">{job.draft_id}</span>
                            </>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400 truncate">
                          Step: {job.current_step}
                        </p>
                      </div>
                    </button>

                    <div className="flex items-center gap-3">
                      {renderJobStatus(job.status)}
                      {needsAction && (
                        <button
                          type="button"
                          onClick={() => onOpenChallenge(job.id)}
                          className="rounded bg-amber-400 px-3 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-amber-300 whitespace-nowrap shrink-0"
                        >
                          Resolve Challenge
                        </button>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-white/[0.07] bg-[#0B0E14] px-6 py-4 space-y-2">
                      {job.logs.length === 0 ? (
                        <p className="text-xs text-slate-500">No step logs recorded yet.</p>
                      ) : (
                        <div className="space-y-1.5 font-mono text-[11px]">
                          {job.logs.map((entry, idx) => (
                            <div key={idx} className="flex items-start gap-3 text-slate-300">
                              <span className="text-slate-500 shrink-0">
                                {new Date(entry.ts).toLocaleTimeString()}
                              </span>
                              <span className="text-[#F0B90B] shrink-0">[{entry.step}]</span>
                              <span className="break-all">{entry.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 3: Publish Audit Log */}
      <section className="rounded-lg border border-white/10 bg-[#12161F] overflow-hidden">
        <div className="border-b border-white/10 px-6 py-4">
          <h2 className="text-base font-semibold text-[#EAECEF]">Publish Execution Audit Log</h2>
        </div>

        {publishLogs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No publish attempts recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 bg-[#0E121A] text-slate-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Article ID</th>
                  <th className="px-5 py-3 font-medium">Publisher Account</th>
                  <th className="px-5 py-3 font-medium">Method</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Published At</th>
                  <th className="px-5 py-3 font-medium">Response / Post Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.07]">
                {publishLogs.map((log) => {
                  const acc = accounts.find((a) => a.id === log.account_id);
                  return (
                    <tr key={log.id} className="hover:bg-white/[0.02]">
                      <td className="px-5 py-3 font-mono text-[#F0B90B]">{log.draft_id}</td>
                      <td className="px-5 py-3 text-slate-200">{acc?.label || log.account_id}</td>
                      <td className="px-5 py-3 font-mono text-slate-400">{log.method}</td>
                      <td className="px-5 py-3 font-mono tabular-nums">
                        <span
                          className={
                            log.http_status >= 200 && log.http_status < 300
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }
                        >
                          {log.http_status}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono text-slate-400">
                        {new Date(log.published_at).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 font-mono text-slate-300 max-w-md truncate">
                        {log.response_body}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
