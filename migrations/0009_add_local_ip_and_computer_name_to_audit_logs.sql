-- Add local_ip and computer_name columns to audit_logs
ALTER TABLE audit_logs ADD COLUMN local_ip TEXT;
ALTER TABLE audit_logs ADD COLUMN computer_name TEXT;
