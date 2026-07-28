import React, { useState, useEffect } from 'react';
import CoreApp, { SaasExtensions, ExtraTab } from 'cohive-frontend/App';
import 'cohive-frontend/global.css';
import { SaaSAdminDashboard } from 'cohive-frontend/components/SaaSAdminDashboard';
import { SaaSLimitModal } from 'cohive-frontend/components/SaaSLimitModal';
import { WorkspaceSubscriptionTab, WorkspaceAuditLogsTab } from 'cohive-frontend/components/WorkspaceSaaSAddon';
import { CreditCard, FileText, Loader, AlertCircle } from 'lucide-react';
import { apiClient } from 'cohive-frontend/utils/apiClient';

export default function App() {
  const [isAdminPortalMode, setIsAdminPortalMode] = useState<boolean | null>(null);
  const [currentAdminPath, setCurrentAdminPath] = useState<string>('');
  const [adminSetupRequired, setAdminSetupRequired] = useState<boolean>(false);
  const [isWorkspaceSuspended, setIsWorkspaceSuspended] = useState<boolean>(false);

  // 選択中ワークスペースのサブスクリプション状態
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<any | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);

  // 1. 管理者ポータルパスの検証
  useEffect(() => {
    const verifyPortalPath = async () => {
      const pathname = window.location.pathname.replace(/^\/+|\/+$/g, "");
      const normalPaths = ["", "channels", "setup", "login", "register", "pwa", "auth"];
      const isNormal = normalPaths.some(p => pathname === p || pathname.startsWith(p + "/"));
      
      if (isNormal) {
        setIsAdminPortalMode(false);
        return;
      }

      try {
        const res = await fetch('/api/admin/verify-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: pathname })
        });
        
        if (res.ok) {
          const data = await res.json() as any;
          if (data.success && data.valid) {
            setIsAdminPortalMode(true);
            setCurrentAdminPath(pathname);
            setAdminSetupRequired(data.setupRequired || false);
            return;
          }
        }
        setIsAdminPortalMode(false);
      } catch (err) {
        console.error("Portal path verification failed:", err);
        setIsAdminPortalMode(false);
      }
    };

    verifyPortalPath();
  }, []);

  // 2. 選択中のワークスペースIDの監視 (localStorage)
  useEffect(() => {
    if (isAdminPortalMode === true) return;

    const checkWorkspaceInterval = setInterval(() => {
      const sessionStr = localStorage.getItem('cohive_session');
      if (sessionStr) {
        try {
          const session = JSON.parse(sessionStr);
          if (session.workspaceId && session.workspaceId !== currentWorkspaceId) {
            setCurrentWorkspaceId(session.workspaceId);
          }
        } catch (e) {
          // ignore
        }
      } else {
        if (currentWorkspaceId !== null) {
          setCurrentWorkspaceId(null);
          setSubscription(null);
          setIsWorkspaceSuspended(false);
        }
      }
    }, 1000);

    return () => clearInterval(checkWorkspaceInterval);
  }, [currentWorkspaceId, isAdminPortalMode]);

  // 3. ワークスペース選択時にサブスクリプション制限状態を取得
  const fetchSubscription = async (wsId: string) => {
    setSubscriptionLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/subscription`);
      if (res.ok) {
        const data = await res.json() as any;
        if (data.success) {
          const sub = data.subscription || data.data;
          if (sub) {
            setSubscription(sub);
            setIsWorkspaceSuspended(sub.status === 'suspended');
          }
        }
      }
    } catch (e) {
      console.error("Failed to fetch subscription:", e);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  useEffect(() => {
    if (currentWorkspaceId) {
      fetchSubscription(currentWorkspaceId);
    } else {
      setSubscription(null);
      setIsWorkspaceSuspended(false);
    }
  }, [currentWorkspaceId]);

  // 一般設定の権限ロール
  const [currentUserRole, setCurrentUserRole] = useState<'owner' | 'group_admin' | 'member' | 'guest'>('member');
  useEffect(() => {
    const fetchUserRole = async () => {
      if (!currentWorkspaceId) return;
      try {
        const sessionStr = localStorage.getItem('cohive_session');
        if (!sessionStr) return;
        const session = JSON.parse(sessionStr);
        const res = await apiClient.get<{ success: boolean; data: any[] }>(`/api/workspaces/${currentWorkspaceId}/members`);
        if (res.success && Array.isArray(res.data)) {
          const me = res.data.find((m: any) => m.userId === session.id);
          if (me) {
            setCurrentUserRole(me.role);
          }
        }
      } catch (e) {
        console.error("Failed to fetch user role:", e);
      }
    };
    fetchUserRole();
  }, [currentWorkspaceId]);

  // 4. 動的追加タブの構築
  const extraTabs: ExtraTab[] = currentWorkspaceId ? [
    {
      id: 'subscription',
      label: 'プラン & 制限',
      icon: <CreditCard size={16} />,
      content: (
        <WorkspaceSubscriptionTab
          workspaceId={currentWorkspaceId}
          workspaceName={""}
          currentUserRole={currentUserRole}
          subscription={subscription}
          onRefreshSubscription={() => fetchSubscription(currentWorkspaceId)}
        />
      ),
      visible: true
    },
    {
      id: 'audit_logs',
      label: '監査ログ',
      icon: <FileText size={16} />,
      content: (
        <WorkspaceAuditLogsTab
          workspaceId={currentWorkspaceId}
          workspaceName={""}
          currentUserRole={currentUserRole}
          subscription={subscription}
          onRefreshSubscription={() => {}}
        />
      ),
      visible: currentUserRole === 'owner' || currentUserRole === 'group_admin'
    }
  ] : [];

  // SaaS拡張定義の実体
  const saasExtensions: SaasExtensions = {
    isSaasMode: true,
    isAdminPortalMode: isAdminPortalMode === true,
    adminSetupRequired,
    currentAdminPath,
    isWorkspaceSuspended,
    renderAdminDashboard: (path, setupReq, onSetupComplete) => (
      <SaaSAdminDashboard
        currentPath={path}
        adminSetupRequired={setupReq}
        onAdminSetupComplete={onSetupComplete}
        onLogoutAdmin={() => {
          window.location.reload();
        }}
      />
    ),
    renderPreparingScreen: () => (
      <div className="setup-container">
        <div className="setup-card" style={{ textAlign: 'center', maxWidth: '460px', padding: '40px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
            <div style={{ background: 'rgba(14, 165, 233, 0.1)', color: '#0ea5e9', padding: '16px', borderRadius: '50%', display: 'inline-flex' }}>
              <Loader size={32} />
            </div>
          </div>
          <h2 className="setup-title" style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 12px 0' }}>
            システム準備中
          </h2>
          <p className="setup-subtitle" style={{ fontSize: '14px', lineHeight: '1.6', color: 'var(--text-muted, #9ca3af)', margin: 0 }}>
            CoHiveシステムは現在初期セットアップ中です。運営者の準備が完了するまでしばらくお待ちください。
          </p>
        </div>
      </div>
    ),
    renderSuspendedScreen: (onLogout) => (
      <div className="setup-container" style={{ background: 'var(--bg-main, #0f172a)' }}>
        <div className="setup-card" style={{ textAlign: 'center', maxWidth: '480px', padding: '40px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
            <div style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '16px', borderRadius: '50%', display: 'inline-flex' }}>
              <AlertCircle size={32} />
            </div>
          </div>
          <h2 className="setup-title" style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 12px 0', color: 'var(--text-primary)' }}>
            ワークスペース一時停止中
          </h2>
          <p className="setup-subtitle" style={{ fontSize: '14px', lineHeight: '1.6', color: 'var(--text-muted)', marginBottom: '24px' }}>
            お支払い情報の確認が取れないため、このワークスペースは現在一時停止されています。
            一般のチャットやファイル機能へのアクセスはできません。
            ワークスペース管理者（オーナー）は、下の設定メニューからサブスクリプション契約状況を再開してください。
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button onClick={onLogout} className="btn btn-secondary">
              ログアウト
            </button>
          </div>
        </div>
      </div>
    ),
    checkWorkspaceLimit: (workspaceCount) => {
      if (workspaceCount >= 3) {
        return {
          limitReached: true,
          message: '無料プランの制限に達しました。作成可能なワークスペースは最大3つまでです。'
        };
      }
      return null;
    },
    saasLimitModal: SaaSLimitModal,
    extraTabs
  };

  // メンバー制限値チェック
  const memberLimitReached = subscription ? subscription.memberUsed >= subscription.memberLimit : false;
  const memberLimitMessage = subscription 
    ? `メンバー上限に達しました（現在の上限: ${subscription.memberLimit} 人）。さらにメンバーを招待するには、プランをアップグレードしてください。`
    : undefined;

  return (
    <CoreApp
      saas={{
        ...saasExtensions,
        // WorkspaceMembersModal内部用Props
        extraTabs
      }}
      // @ts-ignore
      memberLimitReached={memberLimitReached}
      memberLimitMessage={memberLimitMessage}
    />
  );
}
