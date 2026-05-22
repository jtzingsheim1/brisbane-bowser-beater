import type { Metadata } from "next";
import MaintenanceNotice from "@/components/MaintenanceNotice";

export const metadata: Metadata = {
  title: "Data temporarily unavailable — Brisbane Bowser Beater",
  description:
    "The site is paused or refreshing its data. Try again in a few minutes.",
};

export default function MaintenancePage() {
  return <MaintenanceNotice />;
}
