import type { FastifyInstance } from "fastify";
import { contextOf, requirePermission } from "../../http.ts";
import type { Db } from "../../db.ts";
import { DomainError } from "../../errors.ts";
import { registerClinicalCatalogRoutes } from "./clinical-routes.ts";
import { importActs, importPayers, listActs, listDepartments, listPayers } from "./service.ts";

export async function registerCatalogRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Les fichiers CSV arrivent tels quels dans le corps de la requête.
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_request, body, done) =>
    done(null, body),
  );

  app.get("/api/catalog/departments", { preHandler: requirePermission("catalog:read") }, () =>
    listDepartments(db),
  );
  app.get("/api/catalog/payers", { preHandler: requirePermission("catalog:read") }, () =>
    listPayers(db),
  );
  app.get("/api/catalog/acts", { preHandler: requirePermission("catalog:read") }, (request) => {
    const q = request.query as { department?: string; category?: string };
    return listActs(db, {
      ...(q.department ? { department: q.department } : {}),
      ...(q.category ? { category: q.category } : {}),
    });
  });

  const csvBody = (body: unknown): string => {
    if (typeof body !== "string") {
      throw new DomainError(
        "invalid_body",
        "Envoyez le fichier CSV avec l'en-tête Content-Type: text/csv.",
        415,
      );
    }
    return body;
  };

  app.post(
    "/api/catalog/acts/import",
    { preHandler: requirePermission("catalog:manage") },
    (request) => {
      const strict = (request.query as { strict?: string }).strict === "true";
      return importActs(db, contextOf(request), csvBody(request.body), { strict });
    },
  );
  app.post(
    "/api/catalog/payers/import",
    { preHandler: requirePermission("catalog:manage") },
    (request) => {
      const strict = (request.query as { strict?: string }).strict === "true";
      return importPayers(db, contextOf(request), csvBody(request.body), { strict });
    },
  );
  await registerClinicalCatalogRoutes(app, db);
}
