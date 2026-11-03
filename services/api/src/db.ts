import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// DATE (oid 1082) renvoyée en texte AAAA-MM-JJ : pas de conversion de fuseau accidentelle.
pg.types.setTypeParser(1082, (value: string) => value);

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  // Une connexion inactive coupée par le serveur (redémarrage, arrêt) ne doit pas faire tomber le processus :
  // le pool la remplace à la requête suivante.
  pool.on("error", () => undefined);
  return pool;
}

/** Exécute `fn` dans une transaction : validation si elle réussit, annulation si elle lève une erreur. */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("begin");
    const result = await fn(tx);
    await tx.query("commit");
    return result;
  } catch (error) {
    try {
      await tx.query("rollback");
    } catch {
      // la connexion est peut-être déjà perdue ; l'erreur d'origine est plus utile
    }
    throw error;
  } finally {
    tx.release();
  }
}
