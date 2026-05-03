# Service systemd `zenty-drive-scanner` — Installation VPS

> Phase 6 (2026-05-03) : sync auto Drive cross-user, plus de friction "click Sync" pour les VAs.
>
> **Avant** : `driveContentMap` + `driveFolderMap` en localStorage uniquement. Les VAs (sans `hasPerm('syncIG')`) ne pouvaient pas déclencher Sync → zéro fichier visible sur un nouveau navigateur.
>
> **Après** : VPS scanne le Drive toutes les 30 min, écrit `zenty/drive/{folderMap,contentMap,lastScan}` en Firebase. Tous les users (VAs inclus) lisent Firebase au login → médias + previews visibles immédiatement.

---

## Pré-requis (déjà présents sur le VPS)

- `/opt/zenty-cron/.env` avec :
  - `FIREBASE_URL`, `FIREBASE_SECRET`, `CRON_SECRET`
  - `GDRIVE_SA_PATH=/opt/zenty-cron/drive-sa.json` (Service Account JWT, scope drive.readonly)
- `/opt/zenty-cron/drive-sa.json` (déjà déployé pour `data-collector.js`)
- Drive root configuré dans `zenty/config` (clés `drive_root_fr` + `drive_root_us`)
- Backend Docker `zenty-backend` route `/api/drive-scan-run` vers `oneup-proxy/api/drive-scanner.js`

---

## Étape 1 — Déployer le code

Le fichier `oneup-proxy/api/drive-scanner.js` est uploadé via `bash deploy.sh`. Le routing dans `[...path].js` redirige déjà `/api/drive-scan-run` vers ce handler.

**Vérifier après deploy** :

```bash
ls -la /opt/zenty-backend/oneup-proxy/api/drive-scanner.js
grep "drive-scan-run" /opt/zenty-backend/oneup-proxy/api/'[...path].js'
docker restart zenty-backend
```

**Test manuel (smoke)** :

```bash
source /opt/zenty-cron/.env
curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" \
  http://127.0.0.1:3100/api/drive-scan-run | jq
```

Doit retourner `{"ok":true,"elapsed_s":N,"totalAccounts":12,"totalFiles":...}` (durée typique : 15-40s pour 12 comptes).

---

## Étape 2 — Créer le service systemd

```bash
sudo tee /etc/systemd/system/zenty-drive-scanner.service << 'EOF'
[Unit]
Description=Zenty Drive scanner (Phase 6 — sync auto pour tous les users)
After=network.target

[Service]
Type=oneshot
EnvironmentFile=/opt/zenty-cron/.env
ExecStart=/usr/bin/curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" http://127.0.0.1:3100/api/drive-scan-run
StandardOutput=journal
StandardError=journal
TimeoutStartSec=180
EOF
```

## Étape 3 — Créer le timer

```bash
sudo tee /etc/systemd/system/zenty-drive-scanner.timer << 'EOF'
[Unit]
Description=Trigger zenty-drive-scanner toutes les 30 min

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
Unit=zenty-drive-scanner.service
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

## Étape 4 — Activer

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zenty-drive-scanner.timer
sudo systemctl list-timers zenty-drive-scanner*
```

Doit afficher le prochain run dans ~2 min, puis toutes les 30 min.

## Étape 5 — Vérifier le 1er run

```bash
sudo systemctl start zenty-drive-scanner.service
sudo journalctl -u zenty-drive-scanner.service -n 30 --no-pager
```

Doit afficher `[drive-scanner] Done in Xs. accounts=N files=M` puis curl ok.

## Étape 6 — Vérifier Firebase

```bash
source /opt/zenty-cron/.env
curl -fsS "${FIREBASE_URL}/zenty/drive/lastScan.json?auth=${FIREBASE_SECRET}" | jq
```

Doit retourner `{ts, iso, durationMs, totalAccounts, totalFiles, summary:{FR:{...},US:{...}}}`.

---

## Rollback

```bash
sudo systemctl disable --now zenty-drive-scanner.timer
sudo rm /etc/systemd/system/zenty-drive-scanner.{service,timer}
sudo systemctl daemon-reload
# Optionnel : nettoyer Firebase (mais le frontend fallback localStorage si vide, donc pas critique)
# curl -X DELETE "${FIREBASE_URL}/zenty/drive.json?auth=${FIREBASE_SECRET}"
```

---

## Coût

- **Drive API** : ~30 req/scan × 48 scans/jour = 1.4k req/jour. Quota gratuit Drive = 1B/jour. Coût = 0.
- **Firebase** : 3 PUT par run × 48 = 144 writes/jour. Spark plan gratuit ok.
- **CPU VPS** : ~5-15s par scan en mode ioloop. Négligeable.

---

## Monitoring

Le `lastScan` dans Firebase est lisible par le digest matin (`oneup-proxy/api/digest.js`). Si `lastScan.ts` > 2h, le digest devrait alerter "Drive scanner lagging" (TODO si besoin).

Le compteur frontend `window._driveLastScan.ts` est utilisé dans `js/dashboard/content-lib-modal.js` pour afficher "sync auto il y a X min" dans la modal Content Library.
