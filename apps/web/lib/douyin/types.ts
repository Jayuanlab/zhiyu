export interface DouyinPublisherHealth {
  ok: boolean;
  platform: "douyin";
  adapter: string;
  publisher_cli_available: boolean;
  sau_command: string;
  sau_root?: string | null;
  sau_conf_exists?: boolean;
  sau_python?: string;
  account?: string;
  login_command: string[];
  check_command: string[];
  draft_dir: string;
  log_dir: string;
  message: string;
  install_hint?: string;
}

export interface DouyinPublishDraftInput {
  id?: string;
  title: string;
  description?: string;
  topics?: string[];
  video_path: string;
  cover_path?: string | null;
  scheduled_at?: string | null;
  ai_generated?: boolean;
  account_label?: string;
  source?: Record<string, unknown>;
}

export interface DouyinPublishDraft {
  id: string;
  platform: "douyin";
  status: string;
  title: string;
  description: string;
  topics: string[];
  video_path: string;
  cover_path?: string | null;
  scheduled_at?: string | null;
  ai_generated: boolean;
  account_label: string;
  source: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_result?: Record<string, unknown>;
}

export interface DouyinCommandPlan {
  ok: boolean;
  platform: "douyin";
  action: "login" | "check" | "prepare_upload" | "publish";
  execute: boolean;
  command: string[];
  publisher_cli_available?: boolean;
  account_valid?: boolean;
  account_status?: "valid" | "invalid" | "unknown";
  account_status_label?: string;
  message?: string;
  draft?: DouyinPublishDraft;
  result?: Record<string, unknown>;
  error?: string;
}

export interface DouyinDraftCreateResult {
  ok: boolean;
  draft: DouyinPublishDraft;
  path: string;
  error?: string;
}

export interface DouyinDraftListResult {
  ok: boolean;
  drafts: Array<
    Pick<
      DouyinPublishDraft,
      | "id"
      | "title"
      | "status"
      | "description"
      | "topics"
      | "video_path"
      | "cover_path"
      | "scheduled_at"
      | "ai_generated"
      | "account_label"
      | "source"
      | "updated_at"
    >
  >;
}

export interface DouyinDraftGetResult {
  ok: boolean;
  draft: DouyinPublishDraft;
  error?: string;
}
