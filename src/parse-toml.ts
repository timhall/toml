import {
  NodeType,
  Document,
  KeyValue,
  Table,
  TableKey,
  TableArray,
  TableArrayKey,
  Key,
  Value,
  String,
  Integer,
  Float,
  Boolean,
  DateTime,
  InlineTable,
  InlineTableItem,
  InlineArray,
  InlineArrayItem,
  Comment
} from './ast';
import {
  TokenType,
  tokenize,
  findPosition,
  findLines,
  DOUBLE_QUOTE,
  SINGLE_QUOTE,
  IS_FULL_DATE,
  IS_FULL_TIME
} from './tokenizer';
import { parseString, parseKey } from './parse-string';

const TRUE = 'true';
const FALSE = 'false';
const HAS_DOT = /\./;
const HAS_E = /e/i;
const IS_DIVIDER = /\_/g;
const IS_INF = /inf/;
const IS_NAN = /nan/;
const IS_HEX = /^0x/;
const IS_OCTAL = /^0o/;
const IS_BINARY = /^0b/;

export default function parseTOML(input: string): Document {
  const lines = findLines(input);
  const tokens = tokenize(input);

  let current = 0;
  const peek = (skip: number = 1) => tokens[current + skip];
  const step = () => current++;

  function walkBlock(): KeyValue | Table | TableArray | Comment {
    let token = tokens[current];
    const next = (skip: number = 1) => {
      current += skip;
      return tokens[current];
    };

    if (token.token_type === TokenType.Comment) {
      // 1. Comment
      //
      // # line comment
      // ^------------^ Comment
      const comment: Comment = convert(token, node => {
        node.type = NodeType.Comment;
      });

      step();
      return comment;
    } else if (token.token_type === TokenType.Bracket) {
      // 2. Table or TableArray
      //
      // [ key ]
      // ^-----^    TableKey
      //   ^-^      Key
      //
      // [[ key ]]
      // ^ ------^  TableArrayKey
      //    ^-^     Key
      //
      // a = "b"  < Items
      // # c      |
      // d = "f"  <
      //
      // ...
      const type = peek().token_type === TokenType.Bracket ? NodeType.TableArray : NodeType.Table;
      const is_table = type === NodeType.Table;

      if (is_table && token.raw !== '[') {
        throw new Error(`Expected table opening "[", found ${JSON.stringify(token)}`);
      }
      if (!is_table && (token.raw !== '[' || peek().raw !== '[')) {
        throw new Error(
          `Expected array of tables opening "[[", found ${JSON.stringify(
            token
          )} and ${JSON.stringify(peek())}`
        );
      }

      // Set start location from opening tag
      const key = is_table
        ? (convert(token, node => {
            node.type = NodeType.TableKey;
          }) as TableKey)
        : (convert(token, node => {
            node.type = NodeType.TableArrayKey;
          }) as TableArrayKey);

      // Skip to token for key value
      token = type === NodeType.TableArray ? next(2) : next();

      key.value = convert(token, node => {
        node.type = NodeType.Key;
        node.value = parseKey(token.raw);
      });

      token = next();

      if (is_table && token.raw !== ']') {
        throw new Error(`Expected table closing "]", found ${JSON.stringify(token)}`);
      }
      if (!is_table && (token.raw !== ']' || peek().raw !== ']')) {
        throw new Error(
          `Expected array of tables closing "]]", found ${JSON.stringify(
            token
          )} and ${JSON.stringify(peek())}`
        );
      }

      // Set end location from closing tag
      if (!is_table) token = next();
      key.loc.end = token.loc.end;

      token = next();

      // Add child items
      const items: Array<KeyValue | Comment> = [];
      while (token && token.token_type !== TokenType.Bracket) {
        items.push(walkBlock() as (KeyValue | Comment));
        token = tokens[current];
      }

      // (no step(), already stepped to next token in items loop above)
      return {
        type: is_table ? NodeType.Table : NodeType.TableArray,
        loc: {
          start: key.loc.start,
          end: items.length ? items[items.length - 1].loc.end : key.loc.end
        },
        key,
        items
      } as Table | TableArray;
    } else if (token.token_type === TokenType.String) {
      // 3. KeyValue
      //
      // key = value
      // ^-^          key
      //     ^        equals
      //       ^---^  value
      if (peek().token_type !== TokenType.Equal) {
        throw new Error(
          `Expected key = value, found ${JSON.stringify(token)} and ${JSON.stringify(peek())}`
        );
      }

      const key: Key = convert(token, node => {
        node.type = NodeType.Key;
        node.value = parseKey(token.raw);
      });

      token = next();
      const equals = token.loc.start.column;

      token = next();
      const value = walkValue();

      return {
        type: NodeType.KeyValue,
        key,
        value,
        loc: {
          start: key.loc.start,
          end: value.loc.end
        },
        equals
      };
    } else {
      throw new Error(`Unexpected token ${JSON.stringify(token)}`);
    }
  }

  function walkValue(): Value {
    let token = tokens[current];
    const next = (skip: number = 1) => {
      current += skip;
      return tokens[current];
    };

    if (token.token_type === TokenType.String) {
      // 1. String
      if (token.raw[0] === DOUBLE_QUOTE || token.raw[0] === SINGLE_QUOTE) {
        const value: String = convert(token, node => {
          node.type = NodeType.String;
          node.value = parseString(token.raw);
        });

        step();
        return value;
      }

      // 2. Boolean
      if (token.raw === TRUE || token.raw === FALSE) {
        const value: Boolean = convert(token, node => {
          node.type = NodeType.Boolean;
          node.value = token.raw === TRUE;
        });

        step();
        return value;
      }

      // 3. DateTime
      if (IS_FULL_DATE.test(token.raw) || IS_FULL_TIME.test(token.raw)) {
        const value: DateTime = convert(token, node => {
          node.type = NodeType.DateTime;

          // Possible values:
          //
          // Offset Date-Time
          // | odt1 = 1979-05-27T07:32:00Z
          // | odt2 = 1979-05-27T00:32:00-07:00
          // | odt3 = 1979-05-27T00:32:00.999999-07:00
          // | odt4 = 1979-05-27 07:32:00Z
          //
          // Local Date-Time
          // | ldt1 = 1979-05-27T07:32:00
          // | ldt2 = 1979-05-27T00:32:00.999999
          //
          // Local Date
          // | ld1 = 1979-05-27
          //
          // Local Time
          // | lt1 = 07:32:00
          // | lt2 = 00:32:00.999999

          if (!IS_FULL_DATE.test(token.raw)) {
            // For local time, use local ISO date
            const [local_date] = new Date().toISOString().split('T');
            node.value = new Date(`${local_date}T${token.raw}`);
          } else {
            node.value = new Date(token.raw.replace(' ', 'T'));
          }
        });

        step();
        return value;
      }

      // 4. Float
      if (
        HAS_DOT.test(token.raw) ||
        IS_INF.test(token.raw) ||
        IS_NAN.test(token.raw) ||
        (HAS_E.test(token.raw) && !IS_HEX.test(token.raw))
      ) {
        const value: Float = convert(token, node => {
          node.type = NodeType.Float;

          if (IS_INF.test(token.raw)) {
            node.value = token.raw === '-inf' ? -Infinity : Infinity;
          } else if (IS_NAN.test(token.raw)) {
            node.value = token.raw === '-nan' ? -NaN : NaN;
          } else {
            node.value = Number(token.raw.replace(IS_DIVIDER, ''));
          }
        });

        step();
        return value;
      }

      // 5. Integer
      const value: Integer = convert(token, node => {
        node.type = NodeType.Integer;

        let radix = 10;
        if (IS_HEX.test(token.raw)) {
          radix = 16;
        } else if (IS_OCTAL.test(token.raw)) {
          radix = 8;
        } else if (IS_BINARY.test(token.raw)) {
          radix = 2;
        }

        node.value = parseInt(
          token.raw
            .replace(IS_DIVIDER, '')
            .replace(IS_OCTAL, '')
            .replace(IS_BINARY, ''),
          radix
        );
      });

      step();
      return value;
    }

    if (token.token_type === TokenType.Curly) {
      if (token.raw !== '{') {
        throw new Error(`Expected opening brace for inline table, found ${JSON.stringify(token)}`);
      }

      // 6. InlineTable
      const value: InlineTable = convert(token, node => {
        node.type = NodeType.InlineTable;
        node.items = [];
      });

      token = next();

      while (!(token.token_type === TokenType.Curly && token.raw === '}')) {
        if (token.token_type === TokenType.Comma) {
          const previous = value.items[value.items.length - 1];
          if (!previous) {
            throw new Error('Found "," without previous value');
          }

          previous.comma = true;
          previous.loc.end = token.loc.start;

          token = next();
          continue;
        }

        const item = walkBlock();
        if (item.type !== NodeType.KeyValue) {
          throw new Error(
            `Only key-values are supported in inline tables, found ${JSON.stringify(item)}`
          );
        }

        const inline_item: InlineTableItem = {
          type: NodeType.InlineTableItem,
          loc: { start: item.loc.start, end: item.loc.end },
          item,
          comma: false
        };

        value.items.push(inline_item);
        token = tokens[current];
      }

      if (token.token_type !== TokenType.Curly || token.raw !== '}') {
        throw new Error(`Expected closing brace "}", found ${JSON.stringify(token)}`);
      }

      value.loc.end = token.loc.end;

      step();
      return value;
    }

    if (token.token_type !== TokenType.Bracket) {
      throw new Error(`Unrecognized token for value: ${JSON.stringify(token)}`);
    }
    if (token.raw !== '[') {
      throw new Error(`Expected opening brace for inline array, found ${JSON.stringify(token)}`);
    }

    // 7. InlineArray
    const value: InlineArray = convert(token, node => {
      node.type = NodeType.InlineArray;
      node.items = [];
    });

    token = next();

    while (!(token.token_type === TokenType.Bracket && token.raw === ']')) {
      if (token.token_type === TokenType.Comma) {
        const previous = value.items[value.items.length - 1];
        if (!previous) {
          throw new Error('Found "," without previous value');
        }

        previous.comma = true;
        previous.loc.end = token.loc.start;

        token = next();
        continue;
      }
      if (token.token_type === TokenType.Comment) {
        // TODO
        token = next();
        continue;
      }

      const item = walkValue();
      const inline_item: InlineArrayItem = {
        type: NodeType.InlineArrayItem,
        loc: { start: item.loc.start, end: item.loc.end },
        item,
        comma: false
      };

      value.items.push(inline_item);
      token = tokens[current];
    }

    if (token.token_type !== TokenType.Bracket || token.raw !== ']') {
      throw new Error(`Expected closing bracket "]", found ${JSON.stringify(token)}`);
    }

    value.loc.end = token.loc.end;

    step();
    return value;
  }

  let document: Document = {
    type: NodeType.Document,
    loc: { start: { line: 1, column: 0 }, end: findPosition(lines, input.length) },
    body: []
  };

  while (current < tokens.length) {
    document.body.push(walkBlock());
  }

  return document;
}

export function convert<TInput, TOutput>(
  value: TInput,
  conversion: (value: Partial<TOutput>) => void
): TOutput {
  const output: Partial<TOutput> = value;
  conversion(output);

  return output as TOutput;
}
