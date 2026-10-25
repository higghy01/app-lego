# I miei LEGO

App per consultare il catalogo dei set LEGO e tenere traccia della propria collezione.
Funziona sul telefono come un'app normale (si installa dalla schermata Home) e anche senza internet.

## Come è fatta
- `app/` contiene l'app (pagine, grafica e logica).
- `scripts/build_catalog.py` scarica i dati gratuiti di [Rebrickable](https://rebrickable.com/downloads/) e crea il catalogo.
- `scripts/fetch_brickset.py` scarica da [Brickset](https://brickset.com) codici a barre, età e prezzi
  (serve il segreto `BRICKSET_API_KEY`; un po' ogni giorno per rispettare i limiti) e li salva in `data-src/`.
- `app/vendor/` contiene il lettore di codici a barre ZXing (licenza MIT).
- `.github/workflows/pubblica.yml` aggiorna i dati e pubblica l'app su GitHub Pages
  a ogni modifica e ogni mattina.

## Aggiornare il catalogo a mano
Su GitHub: scheda **Actions** → **Aggiorna catalogo e pubblica** → **Run workflow**.

## Dove sono salvati i dati della collezione
Solo sul telefono di chi usa l'app. Dalla scheda **Backup** si esporta un file da conservare
(per esempio su iCloud Drive) e lo si reimporta su un altro telefono.
