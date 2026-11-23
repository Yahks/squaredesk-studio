import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileEdit,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type { DraftStatus } from '../types';

export function DraftStatusLabel({ status }: { status: DraftStatus }) {
  switch (status) {
    case 'published':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Published
        </span>
      );
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 whitespace-nowrap shrink-0">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Approved
        </span>
      );
    case 'scheduled':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#F0B90B] whitespace-nowrap shrink-0">
          <Clock className="h-3.5 w-3.5" />
          Scheduled
        </span>
      );
    case 'publishing':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#FCD535] whitespace-nowrap shrink-0">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Publishing
        </span>
      );
    case 'pending_review':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0">
          <AlertTriangle className="h-3.5 w-3.5" />
          Pending Review
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 whitespace-nowrap shrink-0">
          <XCircle className="h-3.5 w-3.5" />
          Failed
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap shrink-0">
          <XCircle className="h-3.5 w-3.5" />
          Rejected
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 whitespace-nowrap shrink-0">
          <FileEdit className="h-3.5 w-3.5" />
          Draft
        </span>
      );
  }
}

export function HealthStatusLabel({ status }: { status: string }) {
  if (status === 'healthy' || status === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Session Healthy
      </span>
    );
  }
  if (status === 'challenge' || status === 'challenge_required') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0">
        <ShieldAlert className="h-3.5 w-3.5" />
        Challenge Required
      </span>
    );
  }
  if (status === 'expired' || status === 'needs_auth') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0">
        <Clock className="h-3.5 w-3.5" />
        Auth Required
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 whitespace-nowrap shrink-0">
        <XCircle className="h-3.5 w-3.5" />
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap shrink-0">
      <AlertTriangle className="h-3.5 w-3.5" />
      Unconfigured
    </span>
  );
}
