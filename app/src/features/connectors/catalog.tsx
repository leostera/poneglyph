import type { ConnectorName, ConnectorStatus } from "@/lib/poneglyph-api";
import {
  SiDiscord,
  SiDiscordHex,
  SiGithub,
  SiGithubHex,
  SiGmail,
  SiGmailHex,
  SiGooglecalendar,
  SiGooglecalendarHex,
  SiGooglechrome,
  SiGooglechromeHex,
  SiGoogledrive,
  SiGoogledriveHex,
  SiIcloud,
  SiIcloudHex,
  SiImessage,
  SiImessageHex,
  SiLinear,
  SiLinearHex,
  SiNetflix,
  SiNetflixHex,
  SiObsidian,
  SiObsidianHex,
  SiPlex,
  SiPlexHex,
  SiPostgresql,
  SiPostgresqlHex,
  SiSignal,
  SiSignalHex,
  SiSpotify,
  SiSpotifyHex,
  SiSqlite,
  SiSqliteHex,
  SiTelegram,
  SiTelegramHex,
  SiWhatsapp,
  SiWhatsappHex,
  SiX,
  SiXHex,
} from "@icons-pack/react-simple-icons";
import { FolderTree, Mail, Sparkles } from "lucide-react";
import type React from "react";

type BrandIconProps = {
  className?: string;
};

type BrandIconComponent = React.ComponentType<BrandIconProps>;

function brandIcon(
  Icon: React.ComponentType<{
    className?: string;
    color?: string;
    size?: number | string;
    title?: string;
  }>,
  color: string,
  title: string,
): BrandIconComponent {
  return function ConnectorBrandIcon({ className }: BrandIconProps) {
    return <Icon aria-hidden="true" className={className} color={color} size={16} title={title} />;
  };
}

function glyphIcon(
  Icon: React.ComponentType<{ className?: string }>,
  _title: string,
): BrandIconComponent {
  return function ConnectorGlyphIcon({ className }: BrandIconProps) {
    return <Icon className={className} />;
  };
}

function SlackIcon({ className }: BrandIconProps) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
      <rect x="3" y="9.5" width="7" height="3.5" rx="1.75" fill="#36C5F0" />
      <rect x="8.5" y="3" width="3.5" height="7" rx="1.75" fill="#36C5F0" />
      <rect x="11.25" y="3" width="3.5" height="7" rx="1.75" fill="#2EB67D" />
      <rect x="14" y="9.5" width="7" height="3.5" rx="1.75" fill="#2EB67D" />
      <rect x="14" y="11" width="7" height="3.5" rx="1.75" fill="#ECB22E" />
      <rect x="11.25" y="14" width="3.5" height="7" rx="1.75" fill="#ECB22E" />
      <rect x="8.5" y="14" width="3.5" height="7" rx="1.75" fill="#E01E5A" />
      <rect x="3" y="11" width="7" height="3.5" rx="1.75" fill="#E01E5A" />
    </svg>
  );
}

function LinkedInIcon({ className }: BrandIconProps) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
      <rect x="2" y="2" width="20" height="20" rx="4.5" fill="#0A66C2" />
      <circle cx="8.2" cy="8" r="1.35" fill="white" />
      <rect x="6.9" y="10.1" width="2.6" height="7" rx="1" fill="white" />
      <path
        d="M11.4 10.1h2.5v1.05c.52-.8 1.5-1.3 2.84-1.3 2.28 0 3.81 1.52 3.81 4.39v2.86h-2.7v-2.56c0-1.58-.65-2.37-1.95-2.37-1.37 0-2.16.93-2.16 2.37v2.56h-2.69V10.1Z"
        fill="white"
      />
    </svg>
  );
}

export type ConnectorMeta = {
  title: string;
  summary: string;
  icon: BrandIconComponent;
};

export type ConnectorOffering = {
  category: "communication" | "productivity" | "media" | "data" | "social" | "personal-cloud";
  id: string;
  title: string;
  summary: string;
  icon: BrandIconComponent;
  href?: string;
};

export const connectorCatalogCategories = [
  { id: "all", label: "All connectors" },
  { id: "communication", label: "Communication" },
  { id: "productivity", label: "Productivity" },
  { id: "media", label: "Media" },
  { id: "data", label: "Data stores" },
  { id: "social", label: "Social" },
  { id: "personal-cloud", label: "Personal cloud" },
] as const;

export type ConnectorCatalogCategory = (typeof connectorCatalogCategories)[number]["id"];

export const connectorOrder: ConnectorName[] = ["gcal", "plex"];

export const connectorCatalog: Record<ConnectorName, ConnectorMeta> = {
  gcal: {
    title: "Google Calendar",
    summary:
      "Authorize Google Calendar, choose which calendars should stay in sync, and ingest events into the local graph.",
    icon: brandIcon(SiGooglecalendar, SiGooglecalendarHex, "Google Calendar"),
  },
  plex: {
    title: "Plex",
    summary:
      "Scan configured Plex libraries, ingest libraries and items, and skip unchanged libraries across daemon restarts.",
    icon: brandIcon(SiPlex, SiPlexHex, "Plex"),
  },
};

export const connectorOfferings: ConnectorOffering[] = [
  {
    category: "productivity",
    id: "google-calendar",
    title: "Google Calendar",
    summary:
      "Authorize Google Calendar, choose calendars, and sync selected events into the local graph.",
    icon: brandIcon(SiGooglecalendar, SiGooglecalendarHex, "Google Calendar"),
    href: "/connectors/google/onboard/connect",
  },
  {
    category: "communication",
    id: "gmail",
    title: "Gmail",
    summary: "Pull message metadata, threads, senders, and conversation structure into Poneglyph.",
    icon: brandIcon(SiGmail, SiGmailHex, "Gmail"),
  },
  {
    category: "communication",
    id: "email",
    title: "Email",
    summary:
      "Ingest mail over IMAP, POP3, and SMTP for generic mailbox sync outside provider-specific APIs.",
    icon: glyphIcon(Mail, "Email"),
  },
  {
    category: "communication",
    id: "slack",
    title: "Slack",
    summary: "Capture channels, messages, users, and workspace activity from Slack.",
    icon: SlackIcon,
  },
  {
    category: "communication",
    id: "discord",
    title: "Discord",
    summary: "Sync guilds, channels, messages, and voice-adjacent metadata from Discord.",
    icon: brandIcon(SiDiscord, SiDiscordHex, "Discord"),
  },
  {
    category: "productivity",
    id: "obsidian",
    title: "Obsidian",
    summary: "Read vault notes, links, tags, and filesystem metadata from Obsidian vaults.",
    icon: brandIcon(SiObsidian, SiObsidianHex, "Obsidian"),
  },
  {
    category: "data",
    id: "browser-history",
    title: "Browser History",
    summary:
      "Import local browsing history, titles, domains, and timestamps from installed browsers.",
    icon: brandIcon(SiGooglechrome, SiGooglechromeHex, "Google Chrome"),
  },
  {
    category: "personal-cloud",
    id: "icloud",
    title: "iCloud",
    summary: "Sync iCloud-backed calendars, files, notes, and account metadata where accessible.",
    icon: brandIcon(SiIcloud, SiIcloudHex, "iCloud"),
  },
  {
    category: "personal-cloud",
    id: "google-drive",
    title: "Google Drive",
    summary: "Ingest files, folders, sharing metadata, and document identities from Google Drive.",
    icon: brandIcon(SiGoogledrive, SiGoogledriveHex, "Google Drive"),
  },
  {
    category: "productivity",
    id: "chatgpt",
    title: "ChatGPT",
    summary: "Capture chats, projects, prompts, and generated artifacts from ChatGPT.",
    icon: glyphIcon(Sparkles, "ChatGPT"),
  },
  {
    category: "data",
    id: "github",
    title: "GitHub",
    summary: "Sync repositories, issues, pull requests, commits, and discussions from GitHub.",
    icon: brandIcon(SiGithub, SiGithubHex, "GitHub"),
  },
  {
    category: "social",
    id: "linkedin",
    title: "LinkedIn",
    summary: "Ingest profile, company, and network metadata for enrichment and search.",
    icon: LinkedInIcon,
  },
  {
    category: "media",
    id: "plex",
    title: "Plex",
    summary:
      "Scan local Plex libraries, watched media, and related metadata from Plex Media Server.",
    icon: brandIcon(SiPlex, SiPlexHex, "Plex"),
    href: "/connectors/plex",
  },
  {
    category: "communication",
    id: "telegram",
    title: "Telegram",
    summary: "Ingest chats, senders, and message events for local-first memory and search.",
    icon: brandIcon(SiTelegram, SiTelegramHex, "Telegram"),
  },
  {
    category: "productivity",
    id: "linear",
    title: "Linear",
    summary: "Sync issues, projects, comments, and team activity from your Linear workspace.",
    icon: brandIcon(SiLinear, SiLinearHex, "Linear"),
  },
  {
    category: "social",
    id: "x-com",
    title: "X.com",
    summary: "Capture profiles, posts, and link activity for graph enrichment and search.",
    icon: brandIcon(SiX, SiXHex, "X"),
  },
  {
    category: "data",
    id: "postgres",
    title: "Postgres",
    summary: "Mirror selected tables, schemas, and metadata from PostgreSQL databases.",
    icon: brandIcon(SiPostgresql, SiPostgresqlHex, "Postgres"),
  },
  {
    category: "data",
    id: "sqlite",
    title: "SQLite",
    summary: "Read local SQLite databases and project-specific application stores.",
    icon: brandIcon(SiSqlite, SiSqliteHex, "SQLite"),
  },
  {
    category: "data",
    id: "filesystem",
    title: "File System",
    summary:
      "Walk directories, track documents, and enrich local files and folders into the graph.",
    icon: glyphIcon(FolderTree, "File System"),
  },
  {
    category: "communication",
    id: "apple-messages",
    title: "Apple Messages",
    summary: "Ingest local iMessage and SMS metadata from Apple Messages on macOS.",
    icon: brandIcon(SiImessage, SiImessageHex, "Apple Messages"),
  },
  {
    category: "communication",
    id: "whatsapp",
    title: "WhatsApp",
    summary: "Capture chats, contacts, and shared media metadata from WhatsApp.",
    icon: brandIcon(SiWhatsapp, SiWhatsappHex, "WhatsApp"),
  },
  {
    category: "communication",
    id: "signal",
    title: "Signal",
    summary: "Ingest message, contact, and conversation metadata from Signal.",
    icon: brandIcon(SiSignal, SiSignalHex, "Signal"),
  },
  {
    category: "media",
    id: "spotify",
    title: "Spotify",
    summary: "Sync listening history, saved albums, playlists, and artists from Spotify.",
    icon: brandIcon(SiSpotify, SiSpotifyHex, "Spotify"),
  },
  {
    category: "media",
    id: "netflix",
    title: "Netflix",
    summary: "Track watch history, titles, and account-level metadata from Netflix.",
    icon: brandIcon(SiNetflix, SiNetflixHex, "Netflix"),
  },
];

export function sidebarConnectorItems(statuses: ConnectorStatus[] | undefined) {
  return connectorOrder
    .map((name) => {
      const status = statuses?.find((item) => item.name === name);

      if (!status) {
        return null;
      }

      const shouldShow =
        status.connected ||
        status.selectedResourceCount > 0 ||
        (status.name === "plex" && status.enabled);

      if (!shouldShow) {
        return null;
      }

      return {
        href: `/connectors/${name}` as const,
        icon: connectorCatalog[name].icon,
        name,
        title: connectorCatalog[name].title,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function formatSyncTimestamp(timestamp: string | null | undefined) {
  if (!timestamp) {
    return "No sync recorded yet";
  }

  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
