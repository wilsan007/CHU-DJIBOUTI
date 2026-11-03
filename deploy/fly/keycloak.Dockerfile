# Keycloak 26 avec le domaine « chu » importé au démarrage (secrets fournis par les secrets Fly, jamais dans l'image).
FROM quay.io/keycloak/keycloak:26.0 AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build
FROM quay.io/keycloak/keycloak:26.0
COPY --from=build /opt/keycloak/ /opt/keycloak/
COPY infra/keycloak/realm-chu.json /opt/keycloak/data/import/realm-chu.json
ENV KC_DB=postgres KC_HTTP_ENABLED=true KC_PROXY_HEADERS=xforwarded KC_HTTP_RELATIVE_PATH=/auth
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
