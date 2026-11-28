"use client";

import { ManagersHome, type ManagerActions } from "@/app/gerentes/managers-ui";
import type { ManagersPage } from "@/lib/managers/queries";
import { adminCreateAdjustmentAction, adminCreateManagerAccessAction, adminCreateManagerAction, adminDeleteAdjustmentAction, adminDeleteManagerAction, adminLinkClientAction, adminRecordHistoricalCompositionAction, adminRegisterManagerPayoutAction, adminResetManagerPasswordAction, adminReverseCommissionAction, adminUnlinkClientAction, adminUpdateManagerAction } from "../../gerentes-actions";

const actions: ManagerActions = {
  createManager: adminCreateManagerAction, updateManager: adminUpdateManagerAction, linkClient: adminLinkClientAction, unlinkClient: adminUnlinkClientAction, deleteManager: adminDeleteManagerAction,
  registerPayout: adminRegisterManagerPayoutAction, createAdjustment: adminCreateAdjustmentAction, deleteAdjustment: adminDeleteAdjustmentAction, createAccess: adminCreateManagerAccessAction, resetPassword: adminResetManagerPasswordAction, reverseCommission: adminReverseCommissionAction, recordHistorical: adminRecordHistoricalCompositionAction,
};

// Mesma tela que o dono da carteira usa em /gerentes, aqui para o MASTER operar em nome deste cliente SaaS.
export default function ManagersSection({ tenantId, data }: { tenantId: string; data: ManagersPage }) {
  return <ManagersHome data={data} actions={actions} tenantId={tenantId} standalone={false} canManageAccess />;
}
