import { hostRootFor, hostSlotChildren } from "./node";
import { Damage, type HostNode } from "./types";

function damageForAncestor(damage: Damage): Damage {
	let result = Damage.None;
	if ((damage & Damage.Layout) !== 0) result |= Damage.Layout;
	if ((damage & Damage.Text) !== 0) result |= Damage.Text;
	if ((damage & (Damage.Paint | Damage.Link | Damage.Interaction)) !== 0) result |= Damage.Paint;
	return result;
}

/** Invalidate cached runs throughout a subtree, including adopted JSX slots, without scheduling repeatedly. */
export function markSubtreeDamage(node: HostNode, damage: Damage): void {
	node.damage |= damage;
	if (node.kind === "element") {
		for (const child of node.children) markSubtreeDamage(child, damage);
		for (const child of hostSlotChildren(node)) markSubtreeDamage(child, damage);
	}
}

/** Mark a retained node dirty, invalidate ancestor caches, and notify its owning root. */
export function markDamage(node: HostNode, damage: Damage, options: { readonly schedule?: boolean } = {}): void {
	if (damage === Damage.None) return;
	node.damage |= damage;
	const ancestorDamage = damageForAncestor(damage);
	let ancestor = node.parent;
	while (ancestor !== null) {
		ancestor.damage |= ancestorDamage;
		ancestor = ancestor.parent;
	}
	if (options.schedule !== false) hostRootFor(node)?.onDamage(node, damage);
}
