# Prüfstatus der öffentlichen Ableitung

Stand: 19. November 2026.

Der deterministische Kern und die umfangreiche Härtungsprüfung bestanden. Zusätzlich bestanden 59 Agententests mit dem lokalen Fake-SDK ohne Anbieteraufrufe. Geprüft werden unter anderem Schema, bösartige Importe, Zeitkonflikte, fehlerhafte Speicherung, Rücklesen und Wiederherstellung. Für die öffentliche Fassung wurden persönliche Startdaten durch neutrale, synthetische Daten ersetzt. Agenten- und Anbieterzugänge sind damit nicht produktiv validiert.

## Browser-Demo

Die öffentliche Demo (die echte Oberfläche mit Beispieldaten) wird mit `tools/browser-pruefen.cjs` in Chrome unter dem Veröffentlichungspfad /Vie/ geprüft: Übersicht, Aufgabe abhaken, Wochenansicht, Bewerbungen, Handybreite von 390 Pixeln ohne horizontalen Überlauf, JavaScript-Fehler und ausgehende Netzwerkanfragen. Beide Sprachen werden geprüft: Deutsch als Standard, der Wechsel auf Französisch und zurück sowie `?lang=fr`; in jeder Ansicht darf kein Text der jeweils anderen Sprache stehen bleiben. Die Seite lädt keine externen Schriften oder Tracker.

## Reproduzierbarkeit

Die Startbefehle stehen in README.md. Test- und Browserprotokolle bleiben lokal; sie enthalten maschinenspezifische temporäre Pfade. Persönliche Logs werden deshalb nicht als Prüfbelege veröffentlicht.

## Grenzen

Ein lokal bestandener Test mit Fixtures ist kein Nachweis einer produktiven Cloud-Freigabe, einer echten Modellausführung oder eines Kundenbetriebs. Die Browser-Demo zeigt erfundene Beispieldaten und speichert nichts; Assistent und Agent sind darin nicht verbunden.

Die öffentliche Kopie wurde vor dem ersten Push anhand ihrer Git-Dateiliste auf private Benutzerpfade, persönliche Hosts, E-Mail-Adressen und bekannte Schlüsselpräfixe geprüft. Ein solcher Scan ergänzt die begrenzte Dateiauswahl und ersetzt keine unabhängige Sicherheitsprüfung.
