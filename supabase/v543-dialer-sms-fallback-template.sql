-- =========================================================================
-- v543: campaign-level SMS fallback template
-- =========================================================================
--
-- Sent after a MANUAL dial that reached nobody. Manual only, by decision:
-- auto-texting queued cold traffic is a different consent posture from
-- following up with one specific person an agent just chose to call.
--
-- The wording is a per-campaign editable field rather than a constant in
-- code, because the wording is the part that actually gets tuned -- and the
-- message lands from a number the recipient does not recognise, so it has to
-- identify who is texting and why. Changing it must not need a deploy.
--
-- sms_fallback_workflow_id (v524) stays but is dead: it assumed a GHL
-- workflow would do the sending. dialer-sms sends directly instead.
--
-- Applied live 2026-09-05.
-- =========================================================================

alter table dialer_campaigns add column if not exists sms_fallback_enabled boolean not null default false;
alter table dialer_campaigns add column if not exists sms_fallback_template text;

comment on column dialer_campaigns.sms_fallback_template is
  'Sent after an unanswered MANUAL dial. Merge fields: {{first_name}}, {{agent}}. '
  'Must identify the sender -- it arrives from a number the recipient does not know.';
comment on column dialer_campaigns.sms_fallback_workflow_id is
  'DEAD as of v543: assumed a GHL workflow would send. dialer-sms sends directly; '
  'use sms_fallback_template instead.';

-- A starting text so enabling the feature can never send an empty message.
-- Deliberately plain: identifies the caller, says why, and offers an out --
-- which is what keeps a text from an unknown number from reading as spam.
update dialer_campaigns
set sms_fallback_template = 'Hi {{first_name}}, this is {{agent}} at PropTech AI - I just tried calling about your property. Happy to talk whenever suits you, or reply STOP and I won''t text again.'
where sms_fallback_template is null;
