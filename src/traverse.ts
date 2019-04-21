import {
  NodeType,
  Node,
  Document,
  Table,
  TableKey,
  TableArray,
  TableArrayKey,
  KeyValue,
  Key,
  String,
  Integer,
  Float,
  Boolean,
  DateTime,
  Comment,
  InlineArray,
  InlineArrayItem,
  InlineTable,
  InlineTableItem
} from './ast';

export type Visit<TNode = Node> = (node: TNode, parent: TNode | null) => void;
export type EnterExit<TNode = Node> = { enter?: Visit<TNode>; exit?: Visit<TNode> };

export type Visitor = {
  Document?: Visit<Document> | EnterExit<Document>;
  Table?: Visit<Table> | EnterExit<Table>;
  TableKey?: Visit<TableKey> | EnterExit<TableKey>;
  TableArray?: Visit<TableArray> | EnterExit<TableArray>;
  TableArrayKey?: Visit<TableArrayKey> | EnterExit<TableArrayKey>;
  KeyValue?: Visit<KeyValue> | EnterExit<KeyValue>;
  Key?: Visit<Key> | EnterExit<Key>;
  String?: Visit<String> | EnterExit<String>;
  Integer?: Visit<Integer> | EnterExit<Integer>;
  Float?: Visit<Float> | EnterExit<Float>;
  Boolean?: Visit<Boolean> | EnterExit<Boolean>;
  DateTime?: Visit<DateTime> | EnterExit<DateTime>;
  InlineArray?: Visit<InlineArray> | EnterExit<InlineArray>;
  InlineArrayItem?: Visit<InlineArrayItem> | EnterExit<InlineArrayItem>;
  InlineTable?: Visit<InlineTable> | EnterExit<InlineTable>;
  InlineTableItem?: Visit<InlineTableItem> | EnterExit<InlineTableItem>;
  Comment?: Visit<Comment> | EnterExit<Comment>;
};

export default function traverse(node: Node, visitor: Visitor) {
  function traverseArray(array: Node[], parent: Node | null) {
    for (const node of array) {
      traverseNode(node, parent);
    }
  }

  function traverseNode(node: Node, parent: Node | null) {
    const visit = visitor[node.type];

    if (visit && typeof visit === 'function') {
      (visit as Visit)(node, parent);
    }
    if (visit && (visit as EnterExit).enter) {
      (visit as EnterExit).enter!(node, parent);
    }

    switch (node.type) {
      case NodeType.Document:
        traverseArray((node as Document).items, node);
        break;

      case NodeType.Table:
        traverseNode((node as Table).key, node);
        traverseArray((node as Table).items, node);
        break;
      case NodeType.TableKey:
        traverseNode((node as TableKey).item, node);
        break;

      case NodeType.TableArray:
        traverseNode((node as TableArray).key, node);
        traverseArray((node as TableArray).items, node);
        break;
      case NodeType.TableArrayKey:
        traverseNode((node as TableArrayKey).item, node);
        break;

      case NodeType.KeyValue:
        traverseNode((node as KeyValue).key, node);
        traverseNode((node as KeyValue).value, node);
        break;

      case NodeType.InlineArray:
        traverseArray((node as InlineArray).items, node);
        break;
      case NodeType.InlineArrayItem:
        traverseNode((node as InlineArrayItem).item, node);
        break;

      case NodeType.InlineTable:
        traverseArray((node as InlineTable).items, node);
        break;
      case NodeType.InlineTableItem:
        traverseNode((node as InlineTableItem).item, node);
        break;

      case NodeType.Key:
      case NodeType.String:
      case NodeType.Integer:
      case NodeType.Float:
      case NodeType.Boolean:
      case NodeType.DateTime:
      case NodeType.Comment:
        break;

      default:
        throw new Error(`Unrecognized node type "${node.type}"`);
    }

    if (visit && (visit as EnterExit).exit) {
      (visit as EnterExit).exit!(node, parent);
    }
  }

  traverseNode(node, null);
}
