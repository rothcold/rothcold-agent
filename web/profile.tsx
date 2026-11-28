import { useRef, useState } from "react";
import type { Identity, Profile } from "./chat.ts";
import type { WorkspaceClient } from "./noise-workspace.ts";
import { useMedia } from "./noise-media.ts";
import { WorkspaceIcon } from "./workspace-icon.tsx";

type Role = "owner" | "agent";
const label = { owner: "Owner", agent: "Agent" };
export const fallbackName = { owner: "You", agent: "Hermes" };

export function IdentityAvatar({
	identity,
	id,
	base,
}: {
	identity: Role;
	id?: string | null;
	base: WorkspaceClient;
}) {
	const src = useMedia(base, id, "image");
	const [failed, setFailed] = useState("");
	const owner = identity === "owner";
	const icon = owner ? "owner" : "hermes";
	return (
		<span className={`avatar ${owner ? "owner-avatar" : "hermes-avatar"}`}>
			{src && src !== failed ? (
				<img src={src} alt="" onError={() => setFailed(src)} />
			) : (
				<WorkspaceIcon name={icon} />
			)}
		</span>
	);
}

function ProfileIdentity({
	identity,
	role,
	base,
	busy,
	save,
}: {
	identity: Identity;
	role: Role;
	base: WorkspaceClient;
	busy: boolean;
	save: (value: Partial<Identity> | File) => void;
}) {
	const [name, setName] = useState(identity.name);
	const picker = useRef<HTMLInputElement>(null);
	return (
		<div className="profile-identity">
			<div className="profile-avatar">
				<IdentityAvatar identity={role} id={identity.avatar} base={base} />
				<input
					ref={picker}
					type="file"
					aria-label={`${label[role]} avatar image`}
					hidden
					accept="image/png,image/jpeg,image/gif,image/webp"
					disabled={busy}
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						if (file) save(file);
						event.currentTarget.value = "";
					}}
				/>
				<button
					type="button"
					aria-label={`Upload ${label[role]} avatar`}
					disabled={busy}
					onClick={() => picker.current?.click()}
				>
					Upload avatar
				</button>
				{identity.avatar && (
					<button
						type="button"
						className="quiet"
						aria-label={`Remove ${label[role]} avatar`}
						disabled={busy}
						onClick={() => save({ avatar: null })}
					>
						Remove avatar
					</button>
				)}
			</div>
			<form
				method="post"
				onSubmit={(event) => {
					event.preventDefault();
					save({ name });
				}}
			>
				<label htmlFor={`${role}-profile-name`}>{label[role]} name</label>
				<div className="profile-input-row">
					<input
						id={`${role}-profile-name`}
						placeholder={fallbackName[role]}
						value={name}
						disabled={busy}
						onChange={(event) => setName(event.currentTarget.value)}
					/>
					<button
						type="submit"
						aria-label={`Save ${label[role]} name`}
						disabled={busy || name === identity.name || [...name].length > 80}
					>
						Save
					</button>
				</div>
			</form>
		</div>
	);
}
function BackendProfileForm({
	backends,
	selected,
	select,
	busy,
	status,
	sync,
}: {
	backends: Profile["backends"];
	selected: string;
	select: (id: string) => void;
	busy: boolean;
	status: string;
	sync: () => void;
}) {
	return (
		<form
			className="profile-backend"
			method="post"
			onSubmit={(event) => {
				event.preventDefault();
				sync();
			}}
		>
			<label htmlFor="profile-backend">Backend profile</label>
			<div className="profile-input-row">
				<select
					id="profile-backend"
					value={selected}
					onChange={(event) => select(event.currentTarget.value)}
					disabled={busy || !backends.length}
				>
					{!backends.length && <option value="">No backend profile yet</option>}
					{backends.map((item) => (
						<option key={item.id} value={item.id}>
							{item.name || item.kind} ({item.id})
						</option>
					))}
				</select>
				<button type="submit" disabled={busy}>
					Sync from backend
				</button>
			</div>
			{status && (
				<p className="profile-status" role="status">
					{status}
				</p>
			)}
		</form>
	);
}

export function ProfileSettings({
	profile,
	base,
	server,
	onProfile,
	report,
}: {
	profile: Profile | undefined;
	base: WorkspaceClient;
	server: WorkspaceClient;
	onProfile: (profile: Profile) => void;
	report: (message: string) => void;
}) {
	const [backend, setBackend] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	async function perform(action: () => Promise<Profile>) {
		if (busy) return;
		setBusy(true);
		setStatus("");
		report("");
		try {
			onProfile(await action());
		} catch (error) {
			report(
				error instanceof Error ? error.message : "Profile request failed.",
			);
		} finally {
			setBusy(false);
		}
	}
	const selected =
		profile?.backends.find((item) => item.id === backend)?.id ??
		profile?.backends[0]?.id ??
		"";
	function sync() {
		void perform(async () => {
			const target = selected ? { backend: selected } : {};
			const synced = await server.profile(
				(await server.call("sync_profile", target)).profile,
			);
			setStatus(
				synced.sync?.refresh === "refreshed"
					? "Updated from the backend."
					: "Updated from the last saved backend profile.",
			);
			return synced;
		});
	}
	return (
		<section className="settings-profile" aria-labelledby="profile-heading">
			<h2 id="profile-heading">Profile</h2>
			{profile ? (
				<>
					{(["owner", "agent"] as const).map((role) => (
						<ProfileIdentity
							key={`${role}:${profile[role].name}`}
							identity={profile[role]}
							role={role}
							base={base}
							busy={busy}
							save={(value) =>
								void perform(() => server.updateIdentity(role, value))
							}
						/>
					))}
					<BackendProfileForm
						backends={profile.backends}
						selected={selected}
						select={setBackend}
						busy={busy}
						status={status}
						sync={sync}
					/>
				</>
			) : (
				<p className="hint">Loading profile…</p>
			)}
		</section>
	);
}
