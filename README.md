# Downwind wing foil — Golfe du Lion

Module de prévision **vent + mer au large** pour le downwind en wing foil : remonter le vent puis redescendre (aller-retour), ou partir d'un point A pour arriver à un point B vent dans le dos (avec navette). Recalculé toutes les heures par GitHub Actions.

**Page web : https://tomaware.github.io/downwind-foil/** (carte avec curseur d'heure, créneaux, détail par parcours ; à ajouter sur l'écran d'accueil du téléphone). Version texte : [`data/PREVISION.md`](data/PREVISION.md) (meilleurs créneaux des 4 prochains jours, puis chaque parcours toutes les 3 h). Les données complètes pour une future app sont dans `data/downwind.json`.

## Parcours (`engine/runs.json`)

| Parcours | Long. | Sens selon le vent |
|---|---|---|
| Sète ↔ Palavas | 27 km | SO → vers Palavas · NE / ENE → vers Sète |
| Palavas ↔ La Grande-Motte | 10 km | SO → vers la Grande-Motte · ENE → vers Palavas |
| La Grande-Motte ↔ Le Grau-du-Roi (par le Boucanet) | 5 km | SE / ESE → vers la Grande-Motte · O / ONO → vers le Grau-du-Roi |
| Le Boucanet ↔ Plage Sud (Port Camargue) | 5 km | N / NNO → vers la plage Sud · S / SSO → vers le Boucanet |

Les coordonnées, l'orientation de la côte (`normal` = direction du large) et les sorties sont **approximatives** : à corriger avec ta connaissance du terrain. Ajouter un parcours = ajouter un bloc dans `runs.json`.

## Comment la note (0-10) est calculée

Pour chaque parcours et chaque heure, sur deux points à 2 km du bord (au tiers et aux deux tiers du parcours) :

1. **Vent** : AROME 1,3 km → ARPEGE (Météo-France), mélangé à ECMWF IFS au-delà de 2 jours. Note du vent selon le niveau (`engine/config.json` → `"level"`) :

   | Niveau | Démarre | Idéal | Limite |
   |---|---|---|---|
   | débutant | 15 nd | 18-23 nd | 27 nd |
   | intermédiaire (défaut) | 13 nd | 16-25 nd | 30 nd |
   | confirmé | 11 nd | 14-28 nd | 35 nd |

2. **Orientation à la côte** : side-shore (vent le long de la plage) = idéal ; side-on = bien ; de mer = moyen (on est ramené au bord, les bosses déferlent tôt) ; side-off = signalé, réservé aux confirmés à plusieurs ; **de terre = note plafonnée à 1 et signalée dangereuse** (dérive au large en cas de casse ou de chute de vent : tramontane, mistral).
3. **Sens du parcours** : A→B ou B→A selon que le vent pousse vers l'un ou l'autre ; au-delà de 60° entre le vent et l'axe de la côte, ce n'est plus un downwind.
4. **Bosses** : seule la mer qui avance **avec le vent** (à moins de 50°) compte. Les modèles séparent houles et mer du vent : une houle de SE sous un vent de SO est comptée comme **mer croisée** et pénalise. Hauteur idéale 0,7-1,5 m (au-delà, malus selon le niveau).
5. **Période** = espacement des bosses (≈ 1,56·T² m) : 3 s (≈ 15 m, clapot serré) freine le foil ; 6 s (≈ 55 m) très bien ; ≥ 8 s (≈ 100 m) idéal. En Méditerranée, la mer du vent fait rarement plus de 6-7 s : les seuils sont adaptés (le guide Unifoil vise 8-14 s pour l'océan).
6. **Rafales** : rafales / vent moyen > 1,45 pénalisé, > 1,6 signalé.
7. Le vent fait l'essentiel de la note (sans vent, pas de downwind) ; la mer fait la différence entre « correct » et « top » : `note = 10 × vent × côte × sens × rafales × (0,35 + 0,65 × hauteur × période × mer croisée)`.
8. **Créneaux** : heures de jour consécutives ≥ 5/10 dans le même sens, au moins 2 h. « Aller-retour possible » quand le vent est side-shore / side-on et ≤ 26 nd (on peut remonter au vent puis redescendre sans navette).

**Mer vérifiée contre les bouées Candhis** (Sète, Espiguette, Leucate) avec la même méthode que Super Prévi Surf : chaque modèle de vagues est pondéré par son erreur des 3 derniers jours à la bouée, et la dernière mesure corrige les premières heures. Les mesures sont lues dans l'historique publié par Super Prévi Surf, sans consommer le quota Candhis.

Le moteur réutilise `lib/surf-engine.js`, copie du moteur de Super Prévi Surf (lecture des données, calibration, mélange du vent).

## Lancer à la main

```
npm test            # 13 tests
node collector/build.js
```

Sources : Open-Meteo (Météo-France, ECMWF, DWD, NOAA), Candhis – Cerema (licence Etalab), critères downwind : [Unifoil — Downwind Foiling Forecasting Guide](https://uni-foil.com/blogs/knowledge-base/downwind-foiling-forecasting-guide).
