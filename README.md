# 🗺️ Geoimage — Georeferenziazione Mappe Storiche

**Geoimage** è una web app client-side per sovrapporre e georeferenziare mappe storiche (o qualsiasi immagine) sulla cartografia moderna, direttamente nel browser — senza installazione, senza backend, senza API key.

> Progettata e sviluppata da [@gbvitrano](https://github.com/gbvitrano) in collaborazione con **Claude AI (Anthropic)**.

---

## ✨ Funzionalità principali

| Funzione | Descrizione |
|---|---|
| 🖼️ **Overlay distorcibile** | Carica JPG · PNG · WEBP · BMP e posizionalo sulla mappa con maniglie di traslazione, rotazione e distorsione |
| 📍 **GCP (Ground Control Points)** | Aggiungi punti di controllo con doppio clic (immagine + mappa) per georeferenziare con precisione |
| 🔀 **Swipe** | Linea verticale scorrevole che divide l'immagine storica dalla basemap moderna |
| 🔦 **Spotlight** | Cerchio che rivela la basemap (o solo l'immagine) mentre muovi il mouse |
| 📐 **Allineamento ai GCP** | Trasformazione affine (≥3 GCP) o polinomiale 2° (≥6 GCP) con calcolo RMSE |
| 📤 **Export multiplo** | KMZ · GeoTIFF · QGIS .points · World file · GCP GeoJSON · Progetto JSON |
| 🔍 **Geocoding** | Ricerca di luoghi tramite Nominatim/OpenStreetMap |
| 💾 **Salvataggio automatico** | Il progetto viene salvato in `localStorage` e ripristinato al reload |

---

## 🚀 Avvio rapido

Non è richiesta alcuna installazione. L'app è completamente statica e funziona aprendo `index.html` nel browser oppure tramite GitHub Pages.

```
Apri index.html  —  oppure  —  visita la GitHub Pages del repository
```

---

## 🗂️ Struttura del progetto

```
Geoimage/
├── index.html          # Applicazione completa (unico file HTML)
├── js/
│   └── app.js          # Logica applicativa (~2700 righe, ES6+)
├── css/
│   └── style.css       # Stili
├── img/
│   └── logo.png        # Logo OpenDataSicilia
├── doc/
│   ├── palermo.json               # Progetto di esempio (Palermo 1864)
│   ├── palermo.points             # GCP in formato QGIS
│   ├── Palermo_1864_georef.kmz    # Export KMZ di esempio
│   └── Palermo_1864_georef_EPSG4326.tif  # Export GeoTIFF di esempio
└── favicon.png / favicon.ico
```

---

## 📖 Come si usa

### 1 — Cerca la posizione
Usa la barra **Cerca posizione** nella sidebar (es. `"Palermo"` o `"Via Maqueda, Palermo"`). Clic su un risultato per centrare la mappa sull'area di interesse.

### 2 — Carica la mappa storica
Trascina un file immagine nel riquadro **Immagine storica** oppure clicca per aprire il file picker.
Formati supportati: `JPG` · `PNG` · `WEBP` · `BMP`.

### 3 — Posiziona l'immagine
Usa le maniglie direttamente sulla mappa:
- **Cerchio blu** — trascina per spostare l'intera immagine
- **Quadratini bianchi agli angoli** — ridimensiona o distorce
- **Cerchio arancione** — ruota

Oppure usa i pulsanti del pannello **Posiziona overlay** per spostamenti, rotazioni (±5°) e scala (±10%) precisi.

### 4 — Aggiungi i GCP *(almeno 3)*
Premi **G** o clicca il pulsante **GCP** nella toolbar. Per ogni punto di controllo:
1. **Clic 1** — clicca sull'anteprima immagine nella sidebar (coordinate pixel)
2. **Clic 2** — clicca sullo stesso punto nella mappa moderna (coordinate geografiche)

Distribuisci i GCP agli angoli dell'area coperta per una maggiore precisione.

### 5 — Allinea ai GCP
Con ≥ 3 GCP si abilita il pulsante **Allinea immagine ai GCP**. L'app calcola la trasformazione e sposta l'overlay nelle coordinate geografiche corrette. Il valore **RMSE** (in metri) indica la precisione media.

### 6 — Confronta
- **Swipe** — trascina la linea verticale per confrontare immagine storica e basemap affiancate
- **Spotlight** — muovi il mouse per rivelare la basemap sotto l'immagine attraverso un cerchio

### 7 — Esporta
Dal pannello **Export** scegli il formato più adatto al tuo flusso di lavoro.

---

## ⌨️ Scorciatoie da tastiera

| Tasto | Azione |
|---|---|
| `G` | Attiva modalità GCP |
| `Esc` | Annulla GCP in attesa / torna alla navigazione |
| `Canc` / `Backspace` | Rimuove l'ultimo GCP aggiunto |
| `Ctrl + S` | Salva il progetto in localStorage |
| `L` | Blocca / sblocca le maniglie di posizionamento |

---

## 📤 Formati di esportazione

| Formato | Descrizione | Uso tipico |
|---|---|---|
| **KMZ** | KML + immagine embedded (base64) | Google Earth, QGIS, ArcGIS |
| **GeoTIFF** | Raster georeferenziato con metadati CRS | QGIS, ArcGIS, GDAL |
| **QGIS .points** | CSV con GCP per il Georeferenziatore di QGIS | Warp polinomiale avanzato |
| **World file** | Affine 6-linee (pixel center convention) | ArcGIS, GDAL |
| **GCP GeoJSON** | Feature Collection con i punti di controllo | Analisi, documentazione |
| **Progetto JSON** | Immagine + overlay + GCP — salva e ricarica | Archiviazione / ripresa sessione |

### Opzioni GeoTIFF
Il dialog di export GeoTIFF permette di configurare:
- **SR di destinazione:** EPSG:4326 · UTM 32N · UTM 33N · EPSG:3857 (Web Mercator)
- **Ricampionamento:** Bilineare (kernel 2×2) o Nearest-neighbor
- **Risoluzione massima:** 2 000 · 4 000 · 8 000 px (lato lungo)
- **Compressione:** LZW (raccomandata) o nessuna

---

## 🧮 Algoritmi di georeferenziazione

### Trasformazione Affine — Poly1 (≥ 3 GCP)
```
lon = a·px + b·py + c
lat = d·px + e·py + f
```
Calcolo con minimi quadrati sovradeterminati. Supporta traslazione, rotazione, scala e distorsione affine.

### Trasformazione Polinomiale 2° — Poly2 (≥ 6 GCP)
```
lon = a₀ + a₁·px + a₂·py + a₃·px² + a₄·px·py + a₅·py²
lat = d₀ + d₁·px + d₂·py + d₃·px² + d₄·px·py + d₅·py²
```
Calcolo con minimi quadrati. Inversione tramite Newton-Raphson iterativo. Ideale per distorsioni ottiche e proiezioni storiche non euclidee.

### RMSE
```
RMSE = √( Σ residui² / n )    [metri]
```

---

## 🛠️ Stack tecnologico

| Libreria | Versione | Funzione |
|---|---|---|
| [Leaflet.js](https://leafletjs.com/) | 1.9.4 | Mappa interattiva |
| [Leaflet.DistortableImage](https://github.com/publiclab/Leaflet.DistortableImage) | latest | Overlay distorcibile con maniglie |
| [proj4.js](https://proj4js.org/) | 2.11.0 | Riproiezione coordinate (UTM, EPSG, …) |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | Generazione file KMZ / ZIP lato client |
| [Font Awesome](https://fontawesome.com/) | 6.5.2 | Icone vettoriali |
| [Nominatim / OSM](https://nominatim.openstreetmap.org/) | — | Geocoding (no API key richiesta) |

**Frontend:** Vanilla JavaScript ES6+ — nessun framework, nessun bundler.

---

## 🗺️ Mappe di base disponibili

- **OpenStreetMap Standard** — mappa vettoriale generale
- **Esri World Imagery** — fotografia satellitare
- **CartoDB Positron** — vettoriale minimale chiaro
- **CartoDB Dark Matter** — vettoriale scuro

---

## 💡 Suggerimenti

- **Più GCP distribuisci agli angoli** dell'immagine, più precisa sarà la georeferenziazione.
- Il progetto viene **salvato automaticamente** nel browser: ricaricando la pagina ritrovi tutto dove l'hai lasciato.
- Per immagini grandi (> 5 MB) esporta il progetto come **JSON su file** invece di affidarti solo al localStorage.
- Per warp polinomiali di ordine superiore o rettifiche avanzate usa il **Georeferenziatore di QGIS** importando il file `.points` esportato, oppure [MapWarper](https://mapwarper.net/).

---

## 📋 Requisiti

- Browser moderno con supporto ES6+ (Chrome, Edge, Firefox, Safari 2016+)
- Connessione internet per le tile delle mappe di base e il geocoding Nominatim
- Nessun server, nessuna installazione, nessuna API key

---

## 📄 Dati di esempio

Nella cartella `doc/` trovi un progetto completo di georeferenziazione della **Pianta di Palermo del 1864**:

| File | Contenuto |
|---|---|
| `palermo.json` | Progetto completo (importabile con "Importa JSON") |
| `palermo.points` | GCP in formato QGIS Georeferencer |
| `Palermo_1864_georef.kmz` | Export KMZ pronto per Google Earth |
| `Palermo_1864_georef_EPSG4326.tif` | Export GeoTIFF in WGS 84 |

---

## 👥 Crediti

Sviluppato da **[@gbvitrano](https://github.com/gbvitrano)** con il supporto di **[Claude AI — Anthropic](https://www.anthropic.com/)** per le scelte architetturali, l'ottimizzazione del codice e le funzionalità di visualizzazione geospaziale.

Realizzato nell'ambito della community **[OpenDataSicilia](https://opendatasicilia.it/)**.

---

## 🔗 Link utili

- [MapWarper](https://mapwarper.net/) — georeferenziazione cloud con warp avanzato
- [QGIS](https://qgis.org/) — GIS desktop open source
- [Leaflet.DistortableImage](https://github.com/publiclab/Leaflet.DistortableImage) — libreria overlay distorcibile
- [OpenDataSicilia](https://opendatasicilia.it/) — community open data siciliana
