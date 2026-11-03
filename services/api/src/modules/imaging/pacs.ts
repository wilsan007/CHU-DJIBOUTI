import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "../../common/time.ts";
import type { Db } from "../../db.ts";
import { patientSummaries } from "../identity/interface.ts";
import { buildWorklistFile } from "./dicom.ts";

/**
 * Liaison avec Orthanc (serveur d'images DICOM). Orthanc n'est jamais exposé aux utilisateurs : seul le noyau lui parle
 * (compte technique), et chaque image montrée passe par une route du noyau qui contrôle les droits et trace la lecture.
 */
export interface PacsConfig {
  url: string;
  user: string;
  password: string;
  /** Dossier lu par le greffon « Worklists » d'Orthanc (volume partagé avec le conteneur Orthanc). */
  worklistDir: string;
  /** Titre DICOM (AET) de l'appareil attendu dans la liste de travail. */
  stationAet: string;
}

export function pacsConfigFromEnv(env: NodeJS.ProcessEnv): PacsConfig | null {
  if (!env.ORTHANC_URL) return null;
  if (!env.ORTHANC_USER || !env.ORTHANC_PASSWORD || !env.IMAGING_WORKLIST_DIR)
    throw new Error(
      "ORTHANC_USER, ORTHANC_PASSWORD et IMAGING_WORKLIST_DIR sont obligatoires avec ORTHANC_URL",
    );
  return {
    url: env.ORTHANC_URL.replace(/\/$/, ""),
    user: env.ORTHANC_USER,
    password: env.ORTHANC_PASSWORD,
    worklistDir: env.IMAGING_WORKLIST_DIR,
    stationAet: env.IMAGING_STATION_AET ?? "RADIO1",
  };
}

/** Modalité DICOM déduite du code de l'acte (le catalogue des actes n'en porte pas) ; « OT » si inconnu. */
export function modalityOf(actCode: string): string {
  const c = actCode.toUpperCase();
  if (c.includes("ECHO") || c.startsWith("US")) return "US";
  if (c.includes("SCAN") || c.includes("TDM") || c.startsWith("CT")) return "CT";
  if (c.includes("IRM") || c.startsWith("MR")) return "MR";
  if (c.includes("MAMMO")) return "MG";
  if (c.includes("RX") || c.includes("RADIO")) return "CR";
  return "OT";
}

export async function orthanc<T = unknown>(
  cfg: PacsConfig,
  path: string,
  init: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${cfg.url}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64")}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Orthanc a répondu ${res.status} pour ${path}`);
  return (init.raw ? Buffer.from(await res.arrayBuffer()) : await res.json()) as T;
}

interface WlRow {
  id: string;
  patient_id: string;
  act_code: string;
  label_fr: string;
  status: string;
  scheduled_for: Date | null;
  accession: string;
  worklist_state: string | null;
}

const atomicWrite = (dir: string, name: string, data: Buffer): void => {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.tmp`); // Orthanc ne lit que les fichiers .wl
  writeFileSync(tmp, data);
  renameSync(tmp, join(dir, name));
};

/** Écrit la liste de travail des examens à faire ; la retire une fois l'examen rapporté. */
export async function syncWorklists(db: Db, cfg: PacsConfig, now = new Date()) {
  const rows = await db.query<WlRow>(
    `select id, patient_id, act_code, label_fr, status, scheduled_for, accession, worklist_state
       from imaging.requests
      where accession is not null
        and ((status in ('pending', 'scheduled') and worklist_state is null)
             or (status = 'reported' and worklist_state = 'written'))`,
  );
  const people = await patientSummaries(
    db,
    rows.rows.map((r) => r.patient_id),
  );
  let written = 0;
  let removed = 0;
  for (const r of rows.rows) {
    if (r.status === "reported") {
      rmSync(join(cfg.worklistDir, `${r.accession}.wl`), { force: true });
      await db.query("update imaging.requests set worklist_state = 'removed' where id = $1", [
        r.id,
      ]);
      removed += 1;
      continue;
    }
    const p = people.get(r.patient_id);
    if (!p) continue;
    const when = r.scheduled_for ?? now;
    const local = new Date(when.getTime() + 3 * 3_600_000).toISOString();
    atomicWrite(
      cfg.worklistDir,
      `${r.accession}.wl`,
      buildWorklistFile({
        accession: r.accession,
        familyName: p.familyName,
        givenName: p.givenName,
        patientId: p.identifier,
        birthDate: p.birthDate,
        sex: p.sex,
        modality: modalityOf(r.act_code),
        procedure: r.label_fr,
        scheduledDate: r.scheduled_for ? local.slice(0, 10) : localDate(now),
        scheduledTime: local.slice(11, 16),
        stationAet: cfg.stationAet,
      }),
    );
    await db.query("update imaging.requests set worklist_state = 'written' where id = $1", [r.id]);
    written += 1;
  }
  return { written, removed };
}

interface OrthancStudy {
  ID: string;
  MainDicomTags?: {
    AccessionNumber?: string;
    StudyInstanceUID?: string;
    StudyDescription?: string;
  };
  PatientMainDicomTags?: { PatientID?: string };
}

/** Retrouve dans Orthanc les études portant le numéro d'accession de chaque examen en cours ou récent. */
export async function syncStudies(db: Db, cfg: PacsConfig) {
  const reqs = await db.query<{ id: string; accession: string; patient_id: string }>(
    `select r.id, r.accession, r.patient_id
       from imaging.requests r
      where r.accession is not null
        and (r.status = 'in_progress'
             or (r.status = 'reported'
                 and exists (select 1 from imaging.reports p where p.request_id = r.id and p.reported_at > now() - interval '3 days')))`,
  );
  const people = await patientSummaries(
    db,
    reqs.rows.map((r) => r.patient_id),
  );
  let linked = 0;
  let mismatched = 0;
  for (const r of reqs.rows) {
    const found = await orthanc<OrthancStudy[]>(cfg, "/tools/find", {
      body: { Level: "Study", Query: { AccessionNumber: r.accession }, Expand: true },
    });
    for (const s of found) {
      const stats = await orthanc<{ CountInstances: number; CountSeries: number }>(
        cfg,
        `/studies/${s.ID}/statistics`,
      );
      const series = await orthanc<{ MainDicomTags?: { Modality?: string } }[]>(
        cfg,
        `/studies/${s.ID}/series?expand`,
      );
      const dicomPatient = s.PatientMainDicomTags?.PatientID ?? "";
      const match = dicomPatient !== "" && dicomPatient === people.get(r.patient_id)?.identifier;
      await db.query(
        `insert into imaging.studies (request_id, orthanc_id, study_uid, modality, description, dicom_patient_id, patient_match, series_count, instance_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (orthanc_id) do update
           set series_count = excluded.series_count, instance_count = excluded.instance_count, patient_match = excluded.patient_match, last_seen_at = now()`,
        [
          r.id,
          s.ID,
          s.MainDicomTags?.StudyInstanceUID ?? null,
          series[0]?.MainDicomTags?.Modality ?? null,
          s.MainDicomTags?.StudyDescription ?? null,
          dicomPatient,
          match,
          stats.CountSeries,
          stats.CountInstances,
        ],
      );
      if (match) linked += 1;
      else mismatched += 1;
    }
  }
  return { linked, mismatched };
}
