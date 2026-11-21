-- Anzeigenamen für Leitungs-Accounts (statt E-Mail im Änderungsprotokoll).
-- Der Name hängt am Einrichtungscode und wird beim Einlösen übernommen.
alter table public.admins add column if not exists name text;
alter table public.admin_setup add column if not exists name text;
-- claim_admin übernimmt admin_setup.name, _audit nutzt admins.name vor der E-Mail (siehe Supabase-Migration 015_admin_names)
