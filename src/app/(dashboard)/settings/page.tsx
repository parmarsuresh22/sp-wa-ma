'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import dynamic from 'next/dynamic';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

/** Placeholder while a section's code is fetched (first open only). */
function PanelSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true">
      <div className="h-6 w-56 rounded-md bg-muted" />
      <div className="h-4 w-96 max-w-full rounded-md bg-muted" />
      <div className="h-40 rounded-xl border border-border bg-card" />
      <div className="h-24 rounded-xl border border-border bg-card" />
    </div>
  );
}

// Thirteen sections used to ship in one bundle, so opening Settings
// downloaded the template editor, the wish scheduler and the rest even
// to change a name. Each is now its own chunk, fetched when its section
// is opened (and kept afterwards); only that section's data loads too.
// (next/dynamic needs its options written inline as an object literal.)
const SettingsOverview = dynamic(
  () => import('@/components/settings/settings-overview').then((m) => m.SettingsOverview),
  { loading: () => <PanelSkeleton /> },
);
const ProfileForm = dynamic(
  () => import('@/components/settings/profile-form').then((m) => m.ProfileForm),
  { loading: () => <PanelSkeleton /> },
);
const SecurityPanel = dynamic(
  () => import('@/components/settings/security-panel').then((m) => m.SecurityPanel),
  { loading: () => <PanelSkeleton /> },
);
const AppearancePanel = dynamic(
  () => import('@/components/settings/appearance-panel').then((m) => m.AppearancePanel),
  { loading: () => <PanelSkeleton /> },
);
const BrandingPanel = dynamic(
  () => import('@/components/settings/branding-panel').then((m) => m.BrandingPanel),
  { loading: () => <PanelSkeleton /> },
);
const WhatsAppChannels = dynamic(
  () => import('@/components/settings/whatsapp-channels').then((m) => m.WhatsAppChannels),
  { loading: () => <PanelSkeleton /> },
);
const TemplateManager = dynamic(
  () => import('@/components/settings/template-manager').then((m) => m.TemplateManager),
  { loading: () => <PanelSkeleton /> },
);
const QuickRepliesManager = dynamic(
  () => import('@/components/settings/quick-replies-manager').then((m) => m.QuickRepliesManager),
  { loading: () => <PanelSkeleton /> },
);
const FieldsAndTagsPanel = dynamic(
  () => import('@/components/settings/fields-and-tags-panel').then((m) => m.FieldsAndTagsPanel),
  { loading: () => <PanelSkeleton /> },
);
const DealsSettings = dynamic(
  () => import('@/components/settings/deals-settings').then((m) => m.DealsSettings),
  { loading: () => <PanelSkeleton /> },
);
const InboxSettings = dynamic(
  () => import('@/components/settings/inbox-settings').then((m) => m.InboxSettings),
  { loading: () => <PanelSkeleton /> },
);
const WishScheduler = dynamic(
  () => import('@/components/settings/wish-scheduler').then((m) => m.WishScheduler),
  { loading: () => <PanelSkeleton /> },
);
const MembersTab = dynamic(
  () => import('@/components/settings/members-tab').then((m) => m.MembersTab),
  { loading: () => <PanelSkeleton /> },
);
const ApiKeysSettings = dynamic(
  () => import('@/components/settings/api-keys-settings').then((m) => m.ApiKeysSettings),
  { loading: () => <PanelSkeleton /> },
);

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?tab=whatsapp`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  // Functions, not elements: only the open section is ever created.
  const panel: Record<SettingsSection, () => ReactNode> = {
    overview: () => <SettingsOverview onSelect={go} />,
    profile: () => <ProfileForm />,
    security: () => <SecurityPanel />,
    appearance: () => <AppearancePanel />,
    branding: () => <BrandingPanel />,
    whatsapp: () => <WhatsAppChannels />,
    templates: () => <TemplateManager />,
    'quick-replies': () => <QuickRepliesManager />,
    fields: () => <FieldsAndTagsPanel />,
    inbox: () => <InboxSettings />,
    wishes: () => <WishScheduler />,
    deals: () => <DealsSettings />,
    members: () => <MembersTab />,
    api: () => <ApiKeysSettings />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('pageDesc')}
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={go} hints={hints} />
        <div className="min-w-0">{panel[section]()}</div>
      </div>
    </div>
  );
}
