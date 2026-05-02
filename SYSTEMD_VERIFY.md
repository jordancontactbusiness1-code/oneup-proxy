# Service systemd `zenty-verify` — Installation VPS

> Migration F1 (cs-senior-engineer 2026-05-02) : déplace `postVerifyRun` browser → VPS pour autonomie complète.
> **Avant** : si Jordan ne charge pas le dashboard 2h+, aucun rollback automatique.
> **Après** : VPS toutes les 30 min — système marche dashboard fermé.

---

## Pré-requis (déjà présents sur le VPS)

- `/opt/zenty-cron/.env` avec `ONEUP_API_KEY`, `FIREBASE_URL`, `FIREBASE_SECRET`, `CRON_SECRET`, `TG_TOKEN`, `TG_CHAT`, `GDRIVE_SA_PATH=/opt/zenty-cron/drive-sa.json`
- `/opt/zenty-cron/drive-sa.json` — Service Account pour rollback Drive (déjà déployé)
- Backend Docker `zenty-backend` route `/api/verify-run` vers `oneup-proxy/api/verify.js`

## Étape 1 — Déployer le code

Le fichier `oneup-proxy/api/verify.js` est uploadé via `bash deploy.sh` comme tout le code VPS (le deploy.sh existant copie aussi `oneup-proxy/`). Vérifier après deploy :

```bash
ls -la /opt/zenty-backend/oneup-proxy/api/verify.js
```

Le router (`oneup-proxy/api/[...path].js`) doit déjà gérer `/api/verify-run` car le pattern dispatcher catch-all redirige vers les sous-handlers. **Si pas câblé** : ajouter dans `[...path].js` :

```javascript
if (apiPath === '/api/verify-run') {
  return require('./verify.js')(req, res);
}
```

## Étape 2 — Créer le service systemd

```bash
sudo tee /etc/systemd/system/zenty-verify.service << 'EOF'
[Unit]
Description=Zenty post-publish verify (toutes les 30 min)
After=network.target

[Service]
Type=oneshot
EnvironmentFile=/opt/zenty-cron/.env
ExecStart=/usr/bin/curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" http://127.0.0.1:3100/api/verify-run
StandardOutput=journal
StandardError=journal
TimeoutStartSec=300
EOF
```

## Étape 3 — Créer le timer

```bash
sudo tee /etc/systemd/system/zenty-verify.timer << 'EOF'
[Unit]
Description=Trigger zenty-verify toutes les 30 min

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Unit=zenty-verify.service
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

## Étape 4 — Activer

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zenty-verify.timer
sudo systemctl list-timers zenty-verify*
```

Sortie attendue :
```
NEXT                        LEFT     LAST  PASSED  UNIT                ACTIVATES
Sat 2026-05-02 14:30:00 UTC 12min ago Wed   12min   zenty-verify.timer  zenty-verify.service
```

## Étape 5 — Test manuel immédiat

```bash
sudo systemctl start zenty-verify.service
sudo journalctl -u zenty-verify.service -n 50 --no-pager
```

Sortie attendue : `[verify] Done in Xs : verified=N failed=N kept=N errors=0`

## Vérifier côté Firebase

```bash
TODAY=$(date +%Y-%m-%d)
curl -s "https://dashboard-a76d2-default-rtdb.firebaseio.com/zenty/post_verify_results/$TODAY.json?auth=$FIREBASE_SECRET" | jq .
```

Doit retourner `{date, verified:[], failed:[], updatedAt}`.

## Rollback si problème

```bash
sudo systemctl stop zenty-verify.timer
sudo systemctl disable zenty-verify.timer
```

Le browser fait le fallback automatiquement (la queue localStorage continue à fonctionner — fail-safe par design).

---

---

# Service systemd `zenty-digest` — Telegram digest 09h/21h

> Phase 5 — alertes regroupées 2×/jour pour éviter spam à 100 comptes.
> 09h00 Paris = bilan veille (J-1 complet) — 21h00 Paris = bilan aujourd'hui.

## Étape 1 — Service (un seul, slot en argument)

```bash
sudo tee /etc/systemd/system/zenty-digest@.service << 'EOF'
[Unit]
Description=Zenty Telegram digest (slot=%i)
After=network.target

[Service]
Type=oneshot
EnvironmentFile=/opt/zenty-cron/.env
ExecStart=/usr/bin/curl -fsS -X GET -H "x-cron-secret: ${CRON_SECRET}" "http://127.0.0.1:3100/api/digest-run?slot=%i"
StandardOutput=journal
StandardError=journal
TimeoutStartSec=120
EOF
```

## Étape 2 — Timers (matin + soir, heures Paris ≈ UTC)

```bash
# Bilan veille — 09:00 Paris (= 07:00 UTC en été, 08:00 UTC en hiver — utiliser 07:00 UTC suffit, +1h hiver acceptable)
sudo tee /etc/systemd/system/zenty-digest-morning.timer << 'EOF'
[Unit]
Description=Zenty digest matin 09h Paris

[Timer]
OnCalendar=*-*-* 07:00:00
Unit=zenty-digest@morning.service
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Bilan jour — 21:00 Paris
sudo tee /etc/systemd/system/zenty-digest-evening.timer << 'EOF'
[Unit]
Description=Zenty digest soir 21h Paris

[Timer]
OnCalendar=*-*-* 19:00:00
Unit=zenty-digest@evening.service
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

## Étape 3 — Activer

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zenty-digest-morning.timer zenty-digest-evening.timer
sudo systemctl list-timers zenty-digest*
```

## Étape 4 — Test manuel

```bash
sudo systemctl start zenty-digest@morning.service
sudo journalctl -u zenty-digest@morning.service -n 30 --no-pager
```

Doit envoyer un message Telegram au chat configuré.

## Idempotence

Le handler digest.js marque `digestSent_morning` / `digestSent_evening` dans `zenty/post_verify_results/{date}` — re-runs n'envoient pas de doublon (skipped:true). Pour forcer un re-envoi, supprimer le flag :

```bash
TODAY=$(date +%Y-%m-%d)
curl -X DELETE "https://dashboard-a76d2-default-rtdb.firebaseio.com/zenty/post_verify_results/$TODAY/digestSent_evening.json?auth=$FIREBASE_SECRET"
```

---

# Service systemd `zenty-e2e` — Healthcheck E2E quotidien (Phase 4)

> 1×/jour à 14h Paris : programme un post test sur 1 compte sandbox, vérifie veille publiée + verified.

## Pré-config Firebase (1× manuelle Jordan)

1. Créer un compte IG sandbox dédié (ex `@zenty_e2e_test`) connecté à OneUp
2. Mettre 1 fichier mp4 court dans son dossier Drive `reels/`
3. Écrire dans Firebase :
```bash
curl -X PATCH "https://dashboard-a76d2-default-rtdb.firebaseio.com/zenty/e2e_config.json?auth=$FIREBASE_SECRET" -H "Content-Type: application/json" -d '{
  "sandboxAccount": "zenty_e2e_test",
  "sandboxFileId": "<drive_file_id>",
  "sandboxSocialNetworkId": "<oneup_social_network_id>",
  "sandboxCategoryId": "<oneup_category_id>"
}'
```
4. **NE PAS ajouter ce compte dans cron_config/accounts** (sinon double-schedule)

Si `e2e_config` absent : le handler skip silencieux (pas d'alerte).

## Service + Timer

```bash
sudo tee /etc/systemd/system/zenty-e2e.service << 'EOF'
[Unit]
Description=Zenty E2E healthcheck quotidien
After=network.target

[Service]
Type=oneshot
EnvironmentFile=/opt/zenty-cron/.env
ExecStart=/usr/bin/curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" http://127.0.0.1:3100/api/e2e-test
StandardOutput=journal
StandardError=journal
TimeoutStartSec=180
EOF

sudo tee /etc/systemd/system/zenty-e2e.timer << 'EOF'
[Unit]
Description=Zenty E2E 14h Paris

[Timer]
OnCalendar=*-*-* 12:00:00
Unit=zenty-e2e.service
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now zenty-e2e.timer
```

---

# Service systemd `zenty-cache-cleanup` — Stories cache cleanup mensuel (Phase 3)

> 1×/mois (1er à 03h Paris) : supprime les .mp4 cache stories > 30 jours.

```bash
sudo tee /etc/systemd/system/zenty-cache-cleanup.service << 'EOF'
[Unit]
Description=Zenty stories cache cleanup mensuel
After=network.target

[Service]
Type=oneshot
EnvironmentFile=/opt/zenty-cron/.env
ExecStart=/usr/bin/curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" http://127.0.0.1:3100/api/stories-cache-cleanup
StandardOutput=journal
StandardError=journal
TimeoutStartSec=600
EOF

sudo tee /etc/systemd/system/zenty-cache-cleanup.timer << 'EOF'
[Unit]
Description=Zenty cache cleanup mensuel

[Timer]
OnCalendar=*-*-01 01:00:00
Unit=zenty-cache-cleanup.service
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now zenty-cache-cleanup.timer
```

**Test dry-run avant activation** :
```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" "http://127.0.0.1:3100/api/stories-cache-cleanup?dry=1"
```

---

## Architecture observabilité (pour info)

```
┌─ BROWSER ─────────────────────────────┐
│ ouV2SchedulePostForSlot              │
│ → push Firebase zenty/post_verify_   │
│   queue/{postId}                     │
│ → push localStorage (compat fallback)│
└──────────────────────────────────────┘
                │
                ▼ (Firebase queue)
┌─ VPS systemd zenty-verify.timer ─────┐
│ */30min curl POST /api/verify-run    │
│ → fetch queue + OneUp + driveFolderMap│
│ → match published / failed / timeout 2h│
│ → rollback Drive via SA              │
│ → write zenty/post_verify_results/{date}│
│ → Telegram alert si new fails        │
│ → DELETE queue items processed       │
└──────────────────────────────────────┘
                │
                ▼ (Firebase results)
┌─ BROWSER (au boot + toutes 5 min) ───┐
│ postVerifyHydrateFromFirebase        │
│ → lit results, met à jour _postVerify│
│   Results local                      │
│ → notifRender refresh cloche/side-pan│
└──────────────────────────────────────┘
```

Source de vérité : Firebase `zenty/post_verify_results/{date}`. Le localStorage browser est un cache local rafraîchi en continu.
