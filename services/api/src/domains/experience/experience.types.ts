import type {
  AttentionItem,
  NotificationRecord,
  ProcessingJobRecord,
  RecentWorkItem,
  SearchResultKind,
  WorkspaceSearchResult,
} from "ipw-contracts-ts/product";

export interface ExperienceHomeData {
  recentWork: RecentWorkItem[];
  attention: AttentionItem[];
  activeJobs: ProcessingJobRecord[];
  recentJobs: ProcessingJobRecord[];
}

export interface NotificationPageData {
  notifications: NotificationRecord[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface SearchPageData {
  results: WorkspaceSearchResult[];
  nextCursor: string | null;
}

export interface SearchAccess {
  projects: boolean;
  files: boolean;
  jobs: boolean;
}

export interface ExperienceCommand {
  name: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface ExperienceRepository {
  home(actorId: string, workspaceId: string, now: string): Promise<ExperienceHomeData>;
  notifications(
    actorId: string,
    workspaceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<NotificationPageData>;
  markNotificationRead(actorId: string, workspaceId: string, notificationId: string, now: string, command: ExperienceCommand): Promise<boolean>;
  markAllNotificationsRead(actorId: string, workspaceId: string, now: string, command: ExperienceCommand): Promise<boolean>;
  search(
    actorId: string,
    workspaceId: string,
    query: string,
    kinds: SearchResultKind[],
    access: SearchAccess,
    cursor: string | undefined,
    limit: number,
  ): Promise<SearchPageData>;
  close(): Promise<void>;
}

export const EXPERIENCE_REPOSITORY = Symbol("EXPERIENCE_REPOSITORY");
