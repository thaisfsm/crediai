"use client";

import { ManagersHome, type ManagerActions } from "@/app/gerentes/managers-ui";
import type { ManagersPage } from "@/lib/managers/queries";
import { adminCreateManagerAccessAction, adminCreateManagerAction, adminLinkClientAction, adminRegisterManagerPayoutAction, adminResetManagerPasswordAction, adminUnlinkClientAction, adminUpdateManagerAction } from "../../gerentes-actions";

const actions: ManagerActions = {
  createManager: adminCreateManagerAction, updateManager: adminUpdateManagerAction, linkClient: adminLinkClientAction, unlinkClient: adminUnlinkClientAction,
  registerPayout: adminRegisterManagerPayoutAction, createAccess: adminCreateManagerAccessAction, resetPassword: adminResetManagerPasswordAction,
};

// Mesma tela que o dono da carteira usa em /gerentes, aqui para o MASTER operar em nome deste cliente SaaS.
export default function ManagersSection({ tenantId, data }: { tenantId: string; data: ManagersPage }) {
  return <ManagersHome data={data} actions={actions} tenantId={tenantId} standalone={false} />;
}
