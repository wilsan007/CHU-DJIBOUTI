-- Le patient peut refuser les rappels (F3-4).
alter table identity.patients add column reminder_opt_out boolean not null default false;
