# Prüfstatus der öffentlichen Ableitung

Stand: 19. November 2026.

Der deterministische Kern und die umfangreiche Härtungsprüfung bestanden. Zusätzlich bestanden 59 Agententests mit dem lokalen Fake-SDK ohne Anbieteraufrufe. Geprüft werden unter anderem Schema, bösartige Importe, Zeitkonflikte, fehlerhafte Speicherung, Rücklesen und Wiederherstellung. Für die öffentliche Fassung wurden persönliche Startdaten durch neutrale, synthetische Daten ersetzt. Agenten- und Anbieterzugänge sind damit nicht produktiv validiert.

## Browser-Demo

Die öffentliche Projektseite wurde bei 390 und 1440 Pixeln in Chrome geprüft: Code- und Demoverweise, Größenanpassung, interaktive Eingaben, JavaScript-Fehler, Content-Security-Policy und ausgehende Netzwerkanfragen. Die Prüfung blockiert fremde Netzwerkanfragen. Die Seite lädt keine externen Schriften oder Tracker.

## Reproduzierbarkeit

Die Startbefehle stehen in README.md. Test- und Browserprotokolle bleiben lokal; sie enthalten maschinenspezifische temporäre Pfade. Persönliche Logs werden deshalb nicht als Prüfbelege veröffentlicht.

## Grenzen

Ein lokal bestandener Test mit Fixtures ist kein Nachweis einer produktiven Cloud-Freigabe, einer echten Modellausführung oder eines Kundenbetriebs. Die Browser-Demo kennzeichnet gespeicherte beziehungsweise simulierte Ergebnisse.

Die öffentliche Kopie wurde vor dem ersten Push anhand ihrer Git-Dateiliste auf private Benutzerpfade, persönliche Hosts, E-Mail-Adressen und bekannte Schlüsselpräfixe geprüft. Ein solcher Scan ergänzt die begrenzte Dateiauswahl und ersetzt keine unabhängige Sicherheitsprüfung.
