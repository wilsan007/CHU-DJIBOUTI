-- Imagerie : liaison avec le serveur d'images DICOM (Orthanc). Le numéro d'accession est attribué dès la création de
-- l'examen (il sert d'identifiant dans la liste de travail envoyée à l'appareil), puis les études retrouvées sont
-- rattachées à l'examen.
alter table imaging.requests add column worklist_state text check (worklist_state in ('written', 'removed'));

create table imaging.studies (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references imaging.requests (id),
  orthanc_id text not null unique,
  study_uid text,
  modality text,
  description text,
  dicom_patient_id text,
  -- Le PatientID inscrit dans les images doit être l'identifiant du patient de l'examen ; sinon l'étude est signalée
  -- et jamais montrée comme étant celle du patient (risque d'erreur de dossier).
  patient_match boolean not null,
  series_count integer not null default 0,
  instance_count integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index studies_request_idx on imaging.studies (request_id);

grant select, insert, update on imaging.studies to chu_app;
