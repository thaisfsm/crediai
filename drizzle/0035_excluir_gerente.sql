DROP POLICY "account_manager_delete_admin_only" ON "account_manager";--> statement-breakpoint
CREATE POLICY "account_manager_delete_own_or_admin" ON "account_manager" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));
