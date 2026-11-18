'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step0ChooseChannel } from '@/components/broadcasts/step0-choose-channel';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { StepCustomMessage } from '@/components/broadcasts/step-custom-message';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

// A Business API number: pick a template, then personalize it. A
// WhatsApp Web number: write the message. Both start with "send from".
const TEMPLATE_STEPS = ['channel', 'template', 'audience', 'personalize', 'send'] as const;
const MESSAGE_STEPS = ['channel', 'message', 'audience', 'send'] as const;
type StepKey = (typeof TEMPLATE_STEPS)[number] | (typeof MESSAGE_STEPS)[number];

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');
  // "Send from" — chosen in the first step.
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelIsBridge, setChannelIsBridge] = useState(false);
  // Free-text campaign for a WhatsApp Web number.
  const [messageText, setMessageText] = useState('');
  const steps: readonly StepKey[] = channelIsBridge ? MESSAGE_STEPS : TEMPLATE_STEPS;
  const stepIndex = (key: StepKey) => steps.indexOf(key);

  async function handleSend() {
    if (channelIsBridge ? !messageText.trim() : !template) return;

    try {
      const { broadcastId, interruption } = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
        channelId,
        messageText: channelIsBridge ? messageText : null,
      });
      if (interruption === 'lease_lost') toast.warning(t('toastSendTakenOver'));
      if (interruption === 'lease_error') toast.error(t('toastSendInterrupted'));
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : t('broadcastFailed');
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if ((channelIsBridge ? !messageText.trim() : !template) || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      channel_id: channelId,
      name: name.trim(),
      template_name: template?.name ?? '',
      template_language: template?.language ?? 'en_US',
      message_text: channelIsBridge ? messageText.trim() : null,
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {steps[currentStep] === 'channel' && (
            <Step0ChooseChannel
              channelId={channelId}
              onSelect={(c) => {
                setChannelId(c.id);
                const bridge = c.provider === 'waha';
                setChannelIsBridge(bridge);
                if (bridge) setTemplate(null);
                else setMessageText('');
              }}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {steps[currentStep] === 'template' && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(stepIndex('audience'))}
              onBack={() => setCurrentStep(stepIndex('channel'))}
            />
          )}
          {steps[currentStep] === 'message' && (
            <StepCustomMessage
              text={messageText}
              onChange={setMessageText}
              onNext={() => setCurrentStep(stepIndex('audience'))}
              onBack={() => setCurrentStep(stepIndex('channel'))}
            />
          )}
          {steps[currentStep] === 'audience' && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(stepIndex(channelIsBridge ? 'send' : 'personalize'))}
              onBack={() => setCurrentStep(stepIndex(channelIsBridge ? 'message' : 'template'))}
            />
          )}
          {steps[currentStep] === 'personalize' && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(stepIndex('send'))}
              onBack={() => setCurrentStep(stepIndex('audience'))}
            />
          )}
          {steps[currentStep] === 'send' && (channelIsBridge ? messageText.trim() : template) && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              messageText={channelIsBridge ? messageText : null}
              audience={audience}
              channelId={channelId}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(stepIndex(channelIsBridge ? 'audience' : 'personalize'))}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
