/* eslint-disable react/prop-types */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  fetchCollections,
  getSettings,
  normalizeCollectionId,
  normalizeTagName,
  setSettings,
} from "../services/inventory-tags.server";
import {
  cancelBulkSync,
  getBulkSyncJob,
  startBulkSync,
  tickBulkSync,
} from "../services/bulk-sync.server";
import {
  bulkSyncPollDelayMs,
  bulkSyncView,
  isBulkSyncActive,
  isBulkSyncFinished,
  syncScopeLabel,
} from "../lib/bulk-sync-status";

function ZapIcon({ size = 18, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M11.3 1.05a.75.75 0 0 1 .7.95l-1.6 4.5h4.35a.75.75 0 0 1 .55 1.25l-7 8.5a.75.75 0 0 1-1.3-.8l1.6-4.45H4.25a.75.75 0 0 1-.55-1.25l7-8.5a.75.75 0 0 1 .6-.2z" clipRule="evenodd" />
    </svg>
  );
}

function CheckmarkIcon({ size = 18, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M16.704 5.29a1 1 0 0 1 .006 1.414l-8 8.05a1 1 0 0 1-1.42 0l-4-4.025a1 1 0 0 1 1.42-1.408l3.29 3.31 7.29-7.335a1 1 0 0 1 1.414-.006z" clipRule="evenodd" />
    </svg>
  );
}

function PauseIcon({ size = 18, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path d="M6.5 4a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 6.5 4zm7 0a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 13.5 4z" />
    </svg>
  );
}

function TagIcon({ size = 15, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M3.75 3A1.75 1.75 0 0 0 2 4.75v5.086c0 .464.184.91.513 1.237l7.414 7.415a1.75 1.75 0 0 0 2.474 0l5.086-5.086a1.75 1.75 0 0 0 0-2.474l-7.414-7.415A1.75 1.75 0 0 0 8.836 3H3.75zm3 3.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0z" clipRule="evenodd" />
    </svg>
  );
}

function MinusCircleIcon({ size = 16, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM6.75 9.25a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5z" clipRule="evenodd" />
    </svg>
  );
}

function PlusCircleIcon({ size = 16, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm.75-11.25a.75.75 0 0 0-1.5 0v2.5h-2.5a.75.75 0 0 0 0 1.5h2.5v2.5a.75.75 0 0 0 1.5 0v-2.5h2.5a.75.75 0 0 0 0-1.5h-2.5v-2.5z" clipRule="evenodd" />
    </svg>
  );
}

function ShieldCheckIcon({ size = 16, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M10.33 2.1a.75.75 0 0 0-.66 0C8.35 2.76 4 4.8 4 9.5c0 4.14 3.03 7.42 5.56 8.35a1.2 1.2 0 0 0 .88 0c2.53-.93 5.56-4.21 5.56-8.35 0-4.7-4.35-6.74-5.67-7.4zm-.33 5.4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 7.5zm0 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" clipRule="evenodd" />
    </svg>
  );
}

function RefreshIcon({ size = 18, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.325-.326V15a.75.75 0 0 1-1.5 0v-3.25a.75.75 0 0 1 .75-.75H8.25a.75.75 0 0 1 0 1.5H6.87l.432.432a4 4 0 1 0 1.838-5.362.75.75 0 0 1-1.378-.59A5.5 5.5 0 0 1 15.312 11.424z" clipRule="evenodd" />
    </svg>
  );
}

function PlayIcon({ size = 14, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path d="M6.3 3.3a1 1 0 0 0-1.5.86v11.68a1 1 0 0 0 1.5.87l9.74-5.84a1 1 0 0 0 0-1.73L6.3 3.3z" />
    </svg>
  );
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const job = await tickBulkSync(session.shop);

  // The picker is a convenience; a store whose collection list cannot be read
  // must still get a working dashboard, with the saved selection intact.
  const collections = await fetchCollections(admin).catch((error) => {
    console.error("Could not load collections:", error);
    return null;
  });

  return {
    tagName: settings.tagName,
    autoSyncEnabled: settings.autoSyncEnabled,
    collectionId: settings.collectionId,
    collectionTitle: settings.collectionTitle,
    collections: collections ?? [],
    collectionsUnavailable: collections === null,
    job,
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save-settings") {
    const validated = normalizeTagName(formData.get("tagName"));
    if (!validated.ok) {
      return { intent, error: validated.error };
    }

    const collection = normalizeCollectionId(formData.get("collectionId"));
    if (!collection.ok) {
      return { intent, error: collection.error };
    }
    const collectionTitle = collection.collectionId
      ? String(formData.get("collectionTitle") ?? "").trim() || null
      : null;

    try {
      // The tag name and the scope, which this form owns. The Auto Sync toggle
      // is deliberately left out: sending its client-side value along would
      // silently revert a change made in another tab.
      await setSettings(session.shop, {
        tagName: validated.tagName,
        collectionId: collection.collectionId,
        collectionTitle,
      });
      return {
        intent,
        tagName: validated.tagName,
        collectionId: collection.collectionId,
        collectionTitle,
      };
    } catch (error) {
      console.error("Failed to save the settings:", error);
      return { intent, error: "Could not save the settings. Please try again." };
    }
  }

  if (intent === "toggle-auto-sync") {
    const autoSyncEnabled = formData.get("autoSyncEnabled") === "true";
    try {
      await setSettings(session.shop, { autoSyncEnabled });
      return { intent, autoSyncEnabled };
    } catch (error) {
      console.error("Failed to update Automatic Sync:", error);
      // Hand back what is actually stored so the switch snaps back instead of
      // sitting in a state the shop is not in.
      const current = await getSettings(session.shop).catch(() => ({
        autoSyncEnabled: !autoSyncEnabled,
      }));
      return {
        intent,
        error: "Could not update Automatic Sync. Please try again.",
        autoSyncEnabled: current.autoSyncEnabled,
      };
    }
  }

  if (intent === "run-sync") {
    try {
      // Read from the database rather than from the form, so the run always
      // uses the scope that is actually saved.
      const settings = await getSettings(session.shop);
      const job = await startBulkSync(admin, session.shop, settings.tagName, {
        collectionId: settings.collectionId,
        collectionTitle: settings.collectionTitle,
      });
      return { intent, job };
    } catch (error) {
      console.error("Failed to start bulk sync:", error);
      return { intent, error: error.message };
    }
  }

  if (intent === "check-sync") {
    try {
      return { intent, job: await tickBulkSync(session.shop) };
    } catch (error) {
      console.error("Failed to read bulk sync status:", error);
      return { intent, error: error.message, job: await getBulkSyncJob(session.shop) };
    }
  }

  if (intent === "cancel-sync") {
    try {
      return { intent, job: await cancelBulkSync(admin, session.shop) };
    } catch (error) {
      console.error("Failed to cancel bulk sync:", error);
      return { intent, error: error.message };
    }
  }

  return { intent, error: "Unknown action." };
};

export default function InventoryTagsPage() {
  const {
    tagName: initialTagName,
    autoSyncEnabled: initialAutoSync,
    collectionId: initialCollectionId,
    collectionTitle: initialCollectionTitle,
    collections,
    collectionsUnavailable,
    job: initialJob,
  } = useLoaderData();

  const settingsFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const pollFetcher = useFetcher();
  const cancelFetcher = useFetcher();
  const shopify = useAppBridge();
  const notifiedRef = useRef(null);

  const [tagName, setTagName] = useState(initialTagName);
  // What is actually stored, so the field can warn that renaming the tag leaves
  // the old one behind on every product that already carries it.
  const [savedTagName, setSavedTagName] = useState(initialTagName);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(initialAutoSync);

  const [collectionId, setCollectionId] = useState(initialCollectionId || "");
  const [collectionTitle, setCollectionTitle] = useState(
    initialCollectionTitle || "",
  );
  // What is actually stored, so both cards can state the scope a sync would
  // really run with rather than the one the merchant is part-way through
  // choosing.
  const [savedCollectionId, setSavedCollectionId] = useState(
    initialCollectionId || "",
  );
  const [savedCollectionTitle, setSavedCollectionTitle] = useState(
    initialCollectionTitle || "",
  );

  // A collection saved earlier may not be in the loaded page of collections (a
  // very long list, or a list that failed to load). Keeping it as an option
  // means opening the dropdown cannot silently reset the scope to "all".
  const collectionOptions = (() => {
    const options = collections ?? [];
    if (!savedCollectionId || options.some((c) => c.id === savedCollectionId)) {
      return options;
    }
    return [{ id: savedCollectionId, title: savedCollectionTitle || savedCollectionId }, ...options];
  })();

  const handleCollectionChange = (nextId) => {
    setCollectionId(nextId);
    setCollectionTitle(
      collectionOptions.find((c) => c.id === nextId)?.title ?? "",
    );
  };

  const scopeDirty =
    collectionId !== savedCollectionId ||
    (Boolean(collectionId) && collectionTitle !== savedCollectionTitle);

  const savedScopeLabel = syncScopeLabel({
    collectionId: savedCollectionId || null,
    collectionTitle: savedCollectionTitle || null,
  });

  const isSaving = settingsFetcher.state !== "idle";

  const [job, setJob] = useState(initialJob || null);
  const active = isBulkSyncActive(job);
  const isStarting = syncFetcher.state !== "idle";
  const isCancelling = cancelFetcher.state !== "idle";
  const startError = syncFetcher.data?.error;

  useEffect(() => {
    for (const data of [syncFetcher.data, pollFetcher.data, cancelFetcher.data]) {
      if (data?.job) setJob(data.job);
    }
  }, [syncFetcher.data, pollFetcher.data, cancelFetcher.data]);

  const pollRef = useRef(pollFetcher);
  const jobRef = useRef(job);
  useEffect(() => {
    pollRef.current = pollFetcher;
    jobRef.current = job;
  });

  useEffect(() => {
    if (!active) return undefined;

    // Self-scheduling rather than a fixed interval, so the cadence can relax as
    // a long run drags on. Reading the job from a ref keeps this effect tied to
    // `active` alone — depending on `job` would restart the timer on every poll.
    let timer;
    const poll = () => {
      if (pollRef.current.state === "idle") {
        pollRef.current.submit({ intent: "check-sync" }, { method: "POST" });
      }
      timer = setTimeout(poll, bulkSyncPollDelayMs(jobRef.current));
    };

    poll();
    return () => clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    if (settingsFetcher.data?.tagName !== undefined) {
      setTagName(settingsFetcher.data.tagName);
      setSavedTagName(settingsFetcher.data.tagName);
    }
    if (settingsFetcher.data?.autoSyncEnabled !== undefined) {
      setAutoSyncEnabled(settingsFetcher.data.autoSyncEnabled);
    }
    if (
      settingsFetcher.data?.intent === "save-settings" &&
      !settingsFetcher.data.error
    ) {
      const savedId = settingsFetcher.data.collectionId || "";
      const savedTitle = settingsFetcher.data.collectionTitle || "";
      setCollectionId(savedId);
      setCollectionTitle(savedTitle);
      setSavedCollectionId(savedId);
      setSavedCollectionTitle(savedTitle);
    }

    if (settingsFetcher.data?.intent === "save-settings") {
      if (settingsFetcher.data.error) {
        shopify.toast.show(settingsFetcher.data.error, { isError: true });
      } else {
        shopify.toast.show("Settings saved");
      }
    } else if (settingsFetcher.data?.intent === "toggle-auto-sync") {
      if (settingsFetcher.data.error) {
        shopify.toast.show(settingsFetcher.data.error, { isError: true });
      } else {
        shopify.toast.show(
          settingsFetcher.data.autoSyncEnabled
            ? "Automatic inventory sync enabled"
            : "Automatic inventory sync disabled",
        );
      }
    }
  }, [settingsFetcher.data, shopify]);

  useEffect(() => {
    if (!isBulkSyncFinished(job)) return;
    const key = `${job.startedAt}:${job.status}`;
    if (notifiedRef.current === key) return;
    notifiedRef.current = key;

    shopify.toast.show(
      job.status === "completed"
        ? "Catalog sync complete"
        : job.status === "cancelled"
          ? "Catalog sync cancelled"
          : `Sync failed: ${job.errorMessage || "unknown error"}`,
      { isError: job.status === "failed", duration: job.status === "failed" ? 8000 : 4000 },
    );
  }, [job, shopify]);

  const onCancel = useCallback(() => {
    cancelFetcher.submit({ intent: "cancel-sync" }, { method: "POST" });
  }, [cancelFetcher]);

  const handleToggleAutoSync = (enabled) => {
    if (enabled === autoSyncEnabled) return;
    setAutoSyncEnabled(enabled);
    settingsFetcher.submit(
      {
        intent: "toggle-auto-sync",
        autoSyncEnabled: String(enabled),
      },
      { method: "POST" },
    );
  };

  const view = bulkSyncView({ job, isStarting, startError });
  const { percent, progress, elapsed, statusText, stats } = view;

  return (
    <s-page heading="Dashboard">
      <style>{`
        .inventory-dashboard {
          max-width: 920px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 24px;
          font-family: -apple-system, BlinkMacSystemFont, 'San Francisco', 'Segoe UI', Roboto, 'Inter', sans-serif;
          color: #202223;
        }

        .dash-card {
          background: #ffffff;
          border: 1px solid #e1e3e5;
          border-radius: 12px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
          overflow: hidden;
          transition: box-shadow 0.2s ease, border-color 0.2s ease;
        }
        .dash-card:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
        }

        .dash-card-header {
          padding: 20px 24px;
          border-bottom: 1px solid #f1f2f3;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 16px;
        }

        .header-title-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .dash-title {
          font-size: 17px;
          font-weight: 600;
          color: #202223;
          margin: 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .header-icon {
          color: #008060;
          display: inline-flex;
          align-items: center;
        }

        .dash-subtitle {
          font-size: 13px;
          color: #6d7175;
          margin: 0;
        }

        .dash-card-body {
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 22px;
        }

        .auto-sync-hero {
          background: ${autoSyncEnabled ? "#f0fdf4" : "#f6f6f7"};
          border: 1.5px solid ${autoSyncEnabled ? "#bbf7d0" : "#e4e5e7"};
          border-radius: 10px;
          padding: 16px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 16px;
          transition: all 0.25s ease;
        }

        .hero-info {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .hero-icon-wrap {
          width: 42px;
          height: 42px;
          border-radius: 10px;
          background: ${autoSyncEnabled ? "#dcfce7" : "#e4e5e7"};
          color: ${autoSyncEnabled ? "#15803d" : "#6d7175"};
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: all 0.25s ease;
        }

        .hero-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .hero-state-label {
          font-size: 14px;
          font-weight: 600;
          color: ${autoSyncEnabled ? "#166534" : "#303133"};
        }

        .hero-state-desc {
          font-size: 12.5px;
          color: #6d7175;
        }

        .toggle-switch-group {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .switch-toggle-btn {
          position: relative;
          width: 58px;
          height: 32px;
          background: ${autoSyncEnabled ? "#008060" : "#8c9196"};
          border-radius: 16px;
          border: none;
          cursor: pointer;
          padding: 2px;
          transition: background-color 0.25s ease, transform 0.1s ease;
          display: flex;
          align-items: center;
          outline: none;
        }
        .switch-toggle-btn:focus-visible {
          box-shadow: 0 0 0 3px rgba(0, 128, 96, 0.35);
        }
        .switch-toggle-btn:active {
          transform: scale(0.96);
        }

        .switch-knob {
          position: absolute;
          top: 3px;
          left: ${autoSyncEnabled ? "29px" : "3px"};
          width: 26px;
          height: 26px;
          background: #ffffff;
          border-radius: 50%;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
          transition: left 0.22s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .switch-label-text {
          position: absolute;
          font-size: 11px;
          font-weight: 700;
          color: #ffffff;
          user-select: none;
          letter-spacing: 0.5px;
          left: ${autoSyncEnabled ? "9px" : "32px"};
        }

        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          background: ${autoSyncEnabled ? "#dcfce7" : "#e4e5e7"};
          color: ${autoSyncEnabled ? "#166534" : "#4a4d50"};
        }

        .status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: ${autoSyncEnabled ? "#16a34a" : "#8c9196"};
          animation: ${autoSyncEnabled ? "pulse 2s infinite" : "none"};
        }

        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.6); }
          70% { box-shadow: 0 0 0 6px rgba(22, 163, 74, 0); }
          100% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0); }
        }

        .tag-config-section {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .section-label {
          font-size: 13px;
          font-weight: 600;
          color: #202223;
        }

        .tag-input-row {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .tag-input-wrapper {
          position: relative;
          max-width: 380px;
          width: 100%;
        }

        .tag-input {
          width: 100%;
          height: 38px;
          padding: 8px 12px 8px 36px;
          font-size: 14px;
          border: 1.5px solid #babfc3;
          border-radius: 8px;
          background: #ffffff;
          color: #202223;
          box-sizing: border-box;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .tag-input:focus {
          outline: none;
          border-color: #008060;
          box-shadow: 0 0 0 3px rgba(0, 128, 96, 0.2);
        }

        .tag-input-icon {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          color: #6d7175;
          display: inline-flex;
          align-items: center;
          pointer-events: none;
        }

        .save-btn {
          height: 38px;
          padding: 0 18px;
          background: #008060;
          color: #ffffff;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 0.15s ease, transform 0.1s ease;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .save-btn:hover {
          background: #006e52;
        }
        .save-btn:active {
          transform: scale(0.98);
        }
        .save-btn:disabled {
          background: #8c9196;
          cursor: not-allowed;
        }

        .scope-select {
          width: 100%;
          max-width: 380px;
          height: 38px;
          padding: 8px 12px;
          font-size: 14px;
          border: 1.5px solid #babfc3;
          border-radius: 8px;
          background: #ffffff;
          color: #202223;
          box-sizing: border-box;
          cursor: pointer;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .scope-select:focus {
          outline: none;
          border-color: #008060;
          box-shadow: 0 0 0 3px rgba(0, 128, 96, 0.2);
        }
        .scope-select:disabled {
          background: #f6f6f7;
          cursor: not-allowed;
        }

        .scope-hint {
          font-size: 12.5px;
          color: #6d7175;
          line-height: 1.5;
        }

        .scope-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #eef4ff;
          border: 1px solid #c8dcff;
          color: #1e3a8a;
          padding: 3px 10px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;
        }

        .scope-warning {
          background: #fffbeb;
          border: 1px solid #fde68a;
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 12.5px;
          line-height: 1.5;
          color: #78350f;
        }

        .tag-preview-group {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 12.5px;
          color: #6d7175;
          margin-top: 4px;
        }

        .tag-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #e4e5e7;
          color: #202223;
          padding: 3px 10px;
          border-radius: 6px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          font-weight: 500;
          border: 1px solid #d2d5d8;
        }

        .tag-rename-note {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          background: #fffbeb;
          border: 1px solid #fde68a;
          border-radius: 8px;
          padding: 10px 14px;
          margin-top: 8px;
          font-size: 12.5px;
          line-height: 1.5;
          color: #78350f;
        }

        .rules-wrapper {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .rules-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 12px;
        }

        .rule-card {
          background: #fbfbfb;
          border: 1px solid #e1e3e5;
          border-radius: 10px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: border-color 0.2s ease;
        }
        .rule-card:hover {
          border-color: #c9cccf;
        }

        .rule-card-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .rule-pill-add {
          background: #fee2e2;
          color: #991b1b;
          font-size: 11.5px;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }

        .rule-pill-remove {
          background: #dcfce7;
          color: #166534;
          font-size: 11.5px;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }

        .rule-card-desc {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13.5px;
          color: #202223;
          flex-wrap: wrap;
        }

        .rule-condition {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-weight: 600;
        }

        .rule-arrow {
          color: #8c9196;
          font-size: 14px;
        }

        .rule-action-text {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .rules-guardrail {
          background: #f6f6f7;
          border-radius: 8px;
          padding: 10px 14px;
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12.5px;
          color: #6d7175;
        }

        .guardrail-icon {
          color: #008060;
          display: inline-flex;
          align-items: center;
          flex-shrink: 0;
        }

        .manual-sync-actions {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .primary-sync-btn {
          height: 40px;
          padding: 0 20px;
          background: #008060;
          color: #ffffff;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: background-color 0.15s ease, transform 0.1s ease;
        }
        .primary-sync-btn:hover {
          background: #006e52;
        }
        .primary-sync-btn:active {
          transform: scale(0.98);
        }
        .primary-sync-btn:disabled {
          background: #8c9196;
          cursor: not-allowed;
        }

        .cancel-sync-btn {
          height: 40px;
          padding: 0 16px;
          background: #ffffff;
          color: #d72c0d;
          border: 1.5px solid #d72c0d;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }
        .cancel-sync-btn:hover {
          background: #fff4f2;
        }
        .cancel-sync-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .progress-box {
          background: #f6f6f7;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 16px 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .progress-bar-bg {
          width: 100%;
          height: 8px;
          background: #e4e5e7;
          border-radius: 4px;
          overflow: hidden;
        }

        .progress-bar-fill {
          height: 100%;
          background: #008060;
          border-radius: 4px;
          transition: width 0.3s ease;
        }

        /* Shopify does not report a catalog size until the export finishes, so
           there is no percentage to show yet. A sliding bar says "working" where
           a bar frozen at 15% said "stuck". */
        .progress-bar-fill.is-indeterminate {
          width: 35%;
          transition: none;
          animation: indeterminate 1.4s ease-in-out infinite;
        }

        @keyframes indeterminate {
          0% { margin-left: -35%; }
          100% { margin-left: 100%; }
        }

        @media (prefers-reduced-motion: reduce) {
          .progress-bar-fill.is-indeterminate {
            animation: none;
            margin-left: 0;
            width: 100%;
            opacity: 0.45;
          }
          .status-dot {
            animation: none;
          }
        }

        .progress-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12.5px;
          color: #6d7175;
        }

        .sync-stats-bar {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 10px;
          margin-top: 8px;
        }

        .stat-item {
          background: #ffffff;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 10px 14px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .stat-label {
          font-size: 11.5px;
          color: #6d7175;
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }

        .stat-value {
          font-size: 16px;
          font-weight: 700;
          color: #202223;
        }
      `}</style>

      <div className="inventory-dashboard">
        {/* Card 1: Automatic Inventory Sync */}
        <div className="dash-card">
          <div className="dash-card-header">
            <div className="header-title-group">
              <h2 className="dash-title">
                <span className="header-icon"><ZapIcon size={20} /></span> Automatic Inventory Sync
              </h2>
              <p className="dash-subtitle">
                Continuously monitors inventory changes in real-time and applies rules automatically.
              </p>
            </div>
            <div className="status-badge">
              <span className="status-dot" />
              {autoSyncEnabled ? "Sync Active" : "Sync Paused"}
            </div>
          </div>

          <div className="dash-card-body">
            {/* Hero Toggle Control */}
            <div className="auto-sync-hero">
              <div className="hero-info">
                <div className="hero-icon-wrap">
                  {autoSyncEnabled ? <CheckmarkIcon size={20} /> : <PauseIcon size={20} />}
                </div>
                <div className="hero-text">
                  <div className="hero-state-label">
                    {autoSyncEnabled
                      ? "Real-time automatic sync is enabled"
                      : "Automatic inventory sync is paused"}
                  </div>
                  <div className="hero-state-desc">
                    {autoSyncEnabled
                      ? "Shopify webhooks are actively monitoring your inventory."
                      : "Inventory changes in your store will not update tags until turned on."}
                  </div>
                </div>
              </div>

              <div className="toggle-switch-group">
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoSyncEnabled}
                  aria-label="Automatic inventory sync"
                  onClick={() => handleToggleAutoSync(!autoSyncEnabled)}
                  className="switch-toggle-btn"
                  disabled={isSaving}
                  title={autoSyncEnabled ? "Click to disable auto sync" : "Click to enable auto sync"}
                >
                  <span className="switch-label-text">
                    {autoSyncEnabled ? "ON" : "OFF"}
                  </span>
                  <span className="switch-knob" />
                </button>
              </div>
            </div>

            {/* Out-of-Stock Tag Configuration */}
            <settingsFetcher.Form method="post" className="tag-config-section">
              <input type="hidden" name="intent" value="save-settings" />

              <label htmlFor="tagName" className="section-label">
                Out-of-stock tag
              </label>

              <div className="tag-input-row">
                <div className="tag-input-wrapper">
                  <span className="tag-input-icon"><TagIcon size={16} /></span>
                  <input
                    id="tagName"
                    name="tagName"
                    type="text"
                    className="tag-input"
                    value={tagName}
                    onChange={(e) => setTagName(e.target.value)}
                    placeholder="out-of-stock-hidden"
                    required
                  />
                </div>
              </div>

              <div className="tag-preview-group">
                <span>Active tag badge:</span>
                <span className="tag-chip">
                  <TagIcon size={12} /> {tagName || "out-of-stock-hidden"}
                </span>
              </div>

              {tagName.trim() && tagName.trim() !== savedTagName && (
                <div className="tag-rename-note">
                  Renaming only changes what this app writes from now on. Products already
                  carrying <code className="tag-chip">{savedTagName}</code> keep it — remove
                  that tag in bulk from Shopify admin if you no longer want it.
                </div>
              )}

              {/* Sync scope */}
              <label
                htmlFor="collectionId"
                className="section-label"
                style={{ marginTop: "10px" }}
              >
                Sync scope
              </label>

              <select
                id="collectionId"
                name="collectionId"
                className="scope-select"
                value={collectionId}
                onChange={(e) => handleCollectionChange(e.target.value)}
                disabled={collectionsUnavailable && !savedCollectionId}
              >
                <option value="">Entire product catalog (all products)</option>
                {collectionOptions.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.title}
                  </option>
                ))}
              </select>
              {/* Titles are not resolvable from the id alone on the server, so
                  the label the merchant picked travels with the selection. */}
              <input
                type="hidden"
                name="collectionTitle"
                value={collectionTitle}
              />

              <div className="scope-hint">
                {savedCollectionId ? (
                  <>
                    Both Automatic Sync and Manual Full Catalog Sync currently
                    apply to <span className="scope-chip">{savedScopeLabel}</span>.
                    Products outside it are never tagged or untagged by this app.
                  </>
                ) : (
                  <>
                    No collection selected &mdash; both syncs run across your entire
                    active product catalog, exactly as before.
                  </>
                )}
              </div>

              {collectionsUnavailable && (
                <div className="scope-warning">
                  Could not load your collections right now, so the list may be
                  incomplete. Your saved scope is unchanged.
                </div>
              )}

              {scopeDirty && (
                <div className="scope-warning">
                  Scope change not saved yet. Products already tagged under the
                  previous scope keep their tag &mdash; run a sync after saving to
                  bring the new scope in line.
                </div>
              )}

              <div className="tag-input-row">
                <button
                  type="submit"
                  className="save-btn"
                  disabled={isSaving}
                >
                  {isSaving ? "Saving…" : "Save settings"}
                </button>
              </div>

            </settingsFetcher.Form>

            {/* Rules Visual Grid */}
            <div className="rules-wrapper">
              <span className="section-label">Automation Rules</span>
              <div className="rules-grid">
                {/* Rule 1 */}
                <div className="rule-card">
                  <div className="rule-card-top">
                    <span className="rule-pill-add">Rule 1 · Out of stock</span>
                    <span style={{ color: "#991b1b", display: "inline-flex" }}>
                      <MinusCircleIcon size={18} />
                    </span>
                  </div>
                  <div className="rule-card-desc">
                    <span className="rule-condition">Inventory &lt; 1</span>
                    <span className="rule-arrow">&rarr;</span>
                    <span className="rule-action-text">
                      Add tag <code className="tag-chip">{tagName || "out-of-stock-hidden"}</code>
                    </span>
                  </div>
                </div>

                {/* Rule 2 */}
                <div className="rule-card">
                  <div className="rule-card-top">
                    <span className="rule-pill-remove">Rule 2 · Restocked</span>
                    <span style={{ color: "#166534", display: "inline-flex" }}>
                      <PlusCircleIcon size={18} />
                    </span>
                  </div>
                  <div className="rule-card-desc">
                    <span className="rule-condition">Inventory &gt; 0</span>
                    <span className="rule-arrow">&rarr;</span>
                    <span className="rule-action-text">
                      Remove tag <code className="tag-chip">{tagName || "out-of-stock-hidden"}</code>
                    </span>
                  </div>
                </div>
              </div>

              <div className="rules-guardrail">
                <span className="guardrail-icon"><ShieldCheckIcon size={18} /></span>
                <span>
                  <strong>Safety guardrail:</strong> Draft and archived products are never
                  modified. Products that don&rsquo;t track inventory are never tagged &mdash; and
                  the tag is removed if they already carry it.
                  {savedCollectionId
                    ? ` Both rules apply only to products in ${savedCollectionTitle || "the selected collection"}.`
                    : ""}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: Manual Full Catalog Sync */}
        <div className="dash-card">
          <div className="dash-card-header">
            <div className="header-title-group">
              <h2 className="dash-title">
                <span className="header-icon"><RefreshIcon size={20} /></span> Manual Full Catalog Sync
              </h2>
              <p className="dash-subtitle">
                {savedCollectionId
                  ? "Scans the active products in the selected collection in the background and applies or removes tags to match current inventory."
                  : "Scans your entire active product catalog in the background and applies or removes tags to match current inventory."}
              </p>
            </div>
            <span className="scope-chip">{savedScopeLabel}</span>
          </div>

          <div className="dash-card-body">
            <p style={{ margin: 0, fontSize: "13.5px", color: "#6d7175", lineHeight: "1.5" }}>
              Auto Sync handles ongoing inventory updates as they happen. Use <strong>Run sync now</strong> for an initial scan when setting up the app, or anytime you change the tag name or the sync scope.
            </p>

            <div className="manual-sync-actions">
              <syncFetcher.Form method="post">
                <input type="hidden" name="intent" value="run-sync" />
                <button
                  type="submit"
                  className="primary-sync-btn"
                  disabled={active || isStarting}
                >
                  <PlayIcon size={13} />
                  <span>{active || isStarting ? "Sync in progress…" : "Run sync now"}</span>
                </button>
              </syncFetcher.Form>

              {active && (
                <button
                  type="button"
                  className="cancel-sync-btn"
                  onClick={onCancel}
                  disabled={isCancelling}
                >
                  {isCancelling ? "Cancelling…" : "Cancel sync"}
                </button>
              )}
            </div>

            {/* Sync Progress or Outcome Box */}
            {view.mode !== "idle" && (
              <div className="progress-box">
                {view.mode === "running" ? (
                  <>
                    <div className="progress-meta">
                      <strong style={{ color: "#202223" }}>{statusText}</strong>
                      <span>
                        {percent !== null
                          ? `${percent}%`
                          : `${(progress?.current ?? 0).toLocaleString()} products`}
                        {elapsed ? ` · ${elapsed}` : ""}
                      </span>
                    </div>

                    <div
                      className="progress-bar-bg"
                      role="progressbar"
                      aria-label="Catalog sync progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      {...(percent !== null ? { "aria-valuenow": percent } : {})}
                    >
                      <div
                        className={`progress-bar-fill${percent === null ? " is-indeterminate" : ""}`}
                        style={percent === null ? undefined : { width: `${percent}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <s-banner tone={view.tone} heading={view.heading}>
                      <s-paragraph>{statusText}</s-paragraph>
                      {job?.tagged === 0 && job?.untagged === 0 && (job?.processed || 0) > 0 && (
                        <s-paragraph color="subdued">
                          All products are already up to date with your automation rules (no tags needed to be added or removed).
                        </s-paragraph>
                      )}
                      {elapsed && (
                        <s-paragraph color="subdued">Took {elapsed}.</s-paragraph>
                      )}
                    </s-banner>

                    {stats.length > 0 && (
                      <div className="sync-stats-bar">
                        {stats.map((stat) => (
                          <div className="stat-item" key={stat.label}>
                            <span className="stat-label">{stat.label}</span>
                            <span
                              className="stat-value"
                              style={
                                stat.tone === "critical"
                                  ? { color: "#b91c1c" }
                                  : stat.tone === "success"
                                    ? { color: "#15803d" }
                                    : undefined
                              }
                            >
                              {stat.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export function shouldRevalidate({ actionResult, defaultShouldRevalidate }) {
  // Polling checks the sync status every 2 seconds. Re-running the route loader
  // on every check would wastefully refetch collections and settings from Shopify.
  if (actionResult?.intent === "check-sync") {
    return false;
  }
  return defaultShouldRevalidate;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

