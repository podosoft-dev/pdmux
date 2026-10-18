import {
  BinaryOperationNode,
  OperationNodeTransformer,
  OperatorNode,
  PrimitiveValueListNode,
  ValueListNode,
  ValueNode,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from "kysely";

function constantComparison(holds: boolean): BinaryOperationNode {
  return BinaryOperationNode.create(
    ValueNode.createImmediate(1),
    OperatorNode.create("="),
    ValueNode.createImmediate(holds ? 1 : 0),
  );
}

class EmptyListTransformer extends OperationNodeTransformer {
  protected override transformBinaryOperation(node: BinaryOperationNode, queryId?: QueryId): BinaryOperationNode {
    const list = node.rightOperand;
    const empty = (PrimitiveValueListNode.is(list) || ValueListNode.is(list)) && list.values.length === 0;
    if (empty && OperatorNode.is(node.operator)) {
      if (node.operator.operator === "in") return constantComparison(false);
      if (node.operator.operator === "not in") return constantComparison(true);
    }
    return super.transformBinaryOperation(node, queryId);
  }
}

/**
 * Better Auth's Kysely adapter sends an `in` filter on an empty array as
 * `IN ()`, which PostgreSQL rejects as a syntax error. The organization
 * plugin's list-members endpoint looks the members' users up that way, so a
 * filter or page that matched no member answered 500. This plugin sends an
 * empty `in` list as `1 = 0` and an empty `not in` list as `1 = 1`.
 */
export class EmptyListPlugin implements KyselyPlugin {
  private readonly transformer = new EmptyListTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node, args.queryId);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}
