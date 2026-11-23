export type AccountRole = 'scraper' | 'publisher';
export type AccountStatus = 'active' | 'paused' | 'needs_auth' | 'challenge_required';
export type ProviderId = 'gemini' | 'groq' | 'openrouter' | 'amadd';
export type DraftStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'rejected';

export interface Account {
  id: string;
  role: AccountRole;
  label: string;
  login_identifier: string;
  has_password: boolean;
  binance_square_api_key_ref: string;
  has_square_api_key: boolean;
  square_api_key_masked: string;
  status: AccountStatus;
  created_at: string;
}

export interface Persona {
  id: string;
  account_id: string | null;
  display_name: string;
  bio: string;
  niche: string[];
  tone: string;
  style_examples: string[];
  posting_frequency: string;
  active_hours: string[];
  banned_topics: string[];
  writing_rules?: string;
  writing_rules_file?: string;
  created_at: string;
}

export interface BrowserProfile {
  id: string;
  account_id: string;
  dechromium_profile_id: string;
  proxy_display: string;
  has_proxy: boolean;
  proxy_country: string;
  proxy_timezone: string;
  proxy_locale: string;
  user_agent: string;
  viewport_width: number;
  viewport_height: number;
  cookie_count: number;
  last_launched_at: string | null;
  last_health_check: string | null;
  health_status: 'healthy' | 'expired' | 'challenge' | 'unconfigured' | 'error';
  session_valid_until: string | null;
}

export interface SourceComment {
  id: string;
  author: string;
  author_handle: string;
  author_avatar: string;
  user_label: string;
  created_at_label: string;
  content: string;
  likes: string;
  replies_count: string;
  views: string;
  is_thread_reply: boolean;
  post_url: string;
}

export interface SourcePost {
  id: string;
  source_type: string;
  feed_tab: 'discover' | 'following' | 'news' | 'academy' | 'all';
  external_id: string;
  author: string;
  author_handle: string;
  author_avatar: string;
  post_url: string;
  content: string;
  cashtags: string[];
  hashtags: string[];
  media_urls: string[];
  engagement_metrics: {
    comments?: string;
    quotes?: string;
    likes?: string;
    views?: string;
    timestamp_label?: string;
  };
  collected_at: string;
  used_by_persona_ids: string[];
  comments: SourceComment[];
  bundle_file_path?: string;
}

export interface AIProvider {
  id: ProviderId;
  provider_name: string;
  base_url: string;
  key_masked: string;
  available_models: string[];
  selected_model: string;
  validated: boolean;
  last_validated_at: string | null;
  validation_error: string;
}

export interface Draft {
  id: string;
  persona_id: string;
  source_post_ids: string[];
  title: string;
  content: string;
  media_paths: string[];
  post_format: 'short_post' | 'long_article';
  status: DraftStatus;
  llm_provider: string;
  llm_model: string;
  uniqueness_notes: string;
  scheduled_for: string | null;
  generated_at: string;
  reviewed_at: string | null;
  published_at: string | null;
  binance_post_id: string | null;
}

export interface PublishLog {
  id: number;
  draft_id: string;
  account_id: string;
  method: string;
  http_status: number;
  response_body: string;
  published_at: string;
}

export interface AutomationJob {
  id: string;
  job_type: 'scrape' | 'publish' | 'auth_check';
  account_id: string;
  draft_id: string | null;
  feed_tab: string | null;
  status: 'queued' | 'running' | 'awaiting_mfa' | 'awaiting_captcha' | 'completed' | 'failed';
  current_step: string;
  logs: Array<{ ts: string; step: string; message: string }>;
  challenge_screenshot: string | null;
  challenge_message: string;
  created_at: string;
  updated_at: string;
}

export interface GenerationLogEntry {
  ts: string;
  step: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

export interface StandaloneGeneration {
  id: string;
  source_post_ids: string[];
  custom_input: string;
  prompt: string;
  title: string;
  content: string;
  llm_provider: string;
  llm_model: string;
  latency_ms: number;
  status: 'completed' | 'failed';
  error_message: string;
  logs: GenerationLogEntry[];
  created_at: string;
}

export type PipelineStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';
export type CyclePhase = 'scrape' | 'generate' | 'publish';
export type PipelineStage =
  | 'idle'
  | 'scraping'
  | 'generating'
  | 'publishing'
  | 'waiting'
  | 'paused'
  | 'stopped'
  | 'error';

export interface PipelineLogEntry {
  ts: string;
  stage: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

export interface MasterPipeline {
  id: string;
  account_id: string;
  status: PipelineStatus;
  current_stage: PipelineStage;
  cycle_phase: CyclePhase;
  headless: boolean;
  feed_tab: 'discover' | 'following' | 'news' | 'academy' | 'all';
  scrape_target_count: number;
  scrape_interval_hours: number;
  generate_per_cycle: number;
  generate_interval_hours: number;
  min_source_words: number;
  target_min_words: number;
  target_max_words: number;
  provider_id: ProviderId;
  model: string;
  publish_interval_hours: number;
  total_scraped: number;
  total_generated: number;
  total_published: number;
  last_scrape_at: string | null;
  next_scrape_at: string | null;
  last_generate_at: string | null;
  next_generate_at: string | null;
  last_publish_at: string | null;
  next_publish_at: string | null;
  last_error: string;
  logs: PipelineLogEntry[];
  updated_at: string;
}

export interface BootstrapData {
  accounts: Account[];
  personas: Persona[];
  browserProfiles: BrowserProfile[];
  sourcePosts: SourcePost[];
  providers: AIProvider[];
  drafts: Draft[];
  publishLogs: PublishLog[];
  jobs: AutomationJob[];
  standaloneGenerations?: StandaloneGeneration[];
  pipelines?: MasterPipeline[];
  activeBrowserAccountIds?: string[];
}
