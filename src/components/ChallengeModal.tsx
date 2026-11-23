import { useState, type MouseEvent } from 'react';
import { ShieldAlert, KeyRound, Check, X } from 'lucide-react';
import { api } from '../api';
import type { Account, AutomationJob } from '../types';

interface ChallengeModalProps {
  job: AutomationJob;
  account?: Account;
  onResolved: () => void;
  onDismiss: () => void;
}

export function ChallengeModal({ job, account, onResolved, onDismiss }: ChallengeModalProps) {
  const [mfaCode, setMfaCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mfaCode.trim().length < 6) {
      setError('Enter the 6-digit email verification code.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.resolveJobChallenge(job.id, { mfaCode: mfaCode.trim() });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit verification code');
    } finally {
      setSubmitting(false);
    }
  };

  const handleImageClick = async (e: MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    setSubmitting(true);
    try {
      await api.resolveJobChallenge(job.id, {
        captchaAction: { type: 'click', x, y },
      });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to forward click');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCaptchaAction = async (type: 'confirm' | 'abort') => {
    setSubmitting(true);
    setError('');
    try {
      await api.resolveJobChallenge(job.id, {
        captchaAction: { type },
      });
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update challenge');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAbortMfa = async () => {
    setSubmitting(true);
    try {
      await api.resolveJobChallenge(job.id, { mfaCode: '__ABORT__' });
      onResolved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-white/10 bg-[#12161F] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-400" />
            <div>
              <h2 className="text-base font-semibold text-[#EAECEF]">
                {job.status === 'awaiting_mfa'
                  ? 'Email Verification Required'
                  : 'Security CAPTCHA Intervention'}
              </h2>
              <p className="text-xs text-slate-400">
                {account?.label || job.account_id} · Job <span className="font-mono">{job.id}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onDismiss}
            className="rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
            aria-label="Minimize challenge modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-sm text-slate-300">{job.challenge_message}</p>

          {job.challenge_screenshot && (
            <div className="overflow-hidden rounded border border-white/10 bg-[#0B0E14]">
              <img
                src={`data:image/png;base64,${job.challenge_screenshot}`}
                alt="Live browser challenge viewport"
                onClick={job.status === 'awaiting_captcha' ? handleImageClick : undefined}
                className={`w-full max-h-[380px] object-contain ${
                  job.status === 'awaiting_captcha' ? 'cursor-crosshair' : ''
                }`}
              />
              {job.status === 'awaiting_captcha' && (
                <div className="border-t border-white/10 bg-[#181D27] px-3 py-2 text-xs text-slate-400">
                  Click directly on the puzzle target inside the screenshot above to dispatch a mouse click to the isolated browser context.
                </div>
              )}
            </div>
          )}

          {job.status === 'awaiting_mfa' ? (
            <form onSubmit={handleMfaSubmit} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  6-Digit Email Verification Code
                </label>
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] py-2.5 pl-9 pr-4 font-mono text-base tracking-[0.3em] text-white focus:border-[#F0B90B] focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={submitting || mfaCode.length < 6}
                    className="inline-flex items-center gap-2 rounded bg-[#F0B90B] px-5 py-2.5 text-sm font-semibold text-[#0B0E14] transition-colors hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Check className="h-4 w-4" />
                    Submit Code
                  </button>
                  <button
                    type="button"
                    onClick={handleAbortMfa}
                    disabled={submitting}
                    className="rounded border border-white/15 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/5 whitespace-nowrap shrink-0"
                  >
                    Abort
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => handleCaptchaAction('abort')}
                disabled={submitting}
                className="rounded border border-white/15 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-white/5 whitespace-nowrap shrink-0"
              >
                Abort Job
              </button>
              <button
                type="button"
                onClick={() => handleCaptchaAction('confirm')}
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded bg-[#F0B90B] px-5 py-2 text-sm font-semibold text-[#0B0E14] hover:bg-[#FCD535] whitespace-nowrap shrink-0"
              >
                <Check className="h-4 w-4" />
                Captcha Solved — Continue
              </button>
            </div>
          )}

          {error && <p className="text-xs text-rose-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}
