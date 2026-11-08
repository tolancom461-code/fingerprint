# Upgrade v0.17.0 -> v0.17.1

`v0.17.1` is a presentation-only patch for the manual historical Final Event reprocessing dialog.

After a successful manual reprocess, the dialog remains open and shows the result inline in the same window, in addition to the existing global notice. This makes successful completion visible even when the global notice is easy to miss.

No database schema change, SQL migration, `.env` change, Final Event contract change, replay behavior change, automatic historical backfill, main-application change, or device-mode change is introduced.
