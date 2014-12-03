var push = Array.prototype.push;

function elementIntroducesNamespace(element, parentElement){
  return (
    // Root element. Those that have a namespace are entered.
    (!parentElement && element.namespaceURI) ||
    // Inner elements to a namespace
    ( parentElement &&
      ( !element.isHTMLIntegrationPoint && parentElement.namespaceURI !== element.namespaceURI )
    )
  );
}

function Frame() {
  this.parentNode = null;
  this.children = null;
  this.childIndex = null;
  this.childCount = null;
  this.childTemplateCount = 0;
  this.mustacheCount = 0;
  this.actions = [];
}

/**
 * Takes in an AST and outputs a list of actions to be consumed
 * by a compiler. For example, the template
 *
 *     foo{{bar}}<div>baz</div>
 *
 * produces the actions
 *
 *     [['startProgram', [programNode, 0]],
 *      ['text', [textNode, 0, 3]],
 *      ['mustache', [mustacheNode, 1, 3]],
 *      ['openElement', [elementNode, 2, 3, 0]],
 *      ['text', [textNode, 0, 1]],
 *      ['closeElement', [elementNode, 2, 3],
 *      ['endProgram', [programNode]]]
 *
 * This visitor walks the AST depth first and backwards. As
 * a result the bottom-most child template will appear at the
 * top of the actions list whereas the root template will appear
 * at the bottom of the list. For example,
 *
 *     <div>{{#if}}foo{{else}}bar<b></b>{{/if}}</div>
 *
 * produces the actions
 *
 *     [['startProgram', [programNode, 0]],
 *      ['text', [textNode, 0, 2, 0]],
 *      ['openElement', [elementNode, 1, 2, 0]],
 *      ['closeElement', [elementNode, 1, 2]],
 *      ['endProgram', [programNode]],
 *      ['startProgram', [programNode, 0]],
 *      ['text', [textNode, 0, 1]],
 *      ['endProgram', [programNode]],
 *      ['startProgram', [programNode, 2]],
 *      ['openElement', [elementNode, 0, 1, 1]],
 *      ['block', [blockNode, 0, 1]],
 *      ['closeElement', [elementNode, 0, 1]],
 *      ['endProgram', [programNode]]]
 *
 * The state of the traversal is maintained by a stack of frames.
 * Whenever a node with children is entered (either a ProgramNode
 * or an ElementNode) a frame is pushed onto the stack. The frame
 * contains information about the state of the traversal of that
 * node. For example,
 *
 *   - index of the current child node being visited
 *   - the number of mustaches contained within its child nodes
 *   - the list of actions generated by its child nodes
 */

function TemplateVisitor() {
  this.frameStack = [];
  this.actions = [];
  this.programDepth = -1;
}

// Traversal methods

TemplateVisitor.prototype.visit = function(node) {
  this[node.type](node);
};

TemplateVisitor.prototype.Program = function(program) {
  this.programDepth++;

  var parentFrame = this.getCurrentFrame();
  var programFrame = this.pushFrame();

  programFrame.parentNode = program;
  programFrame.children = program.body;
  programFrame.childCount = program.body.length;
  programFrame.blankChildTextNodes = [];
  programFrame.actions.push(['endProgram', [program, this.programDepth]]);

  for (var i = program.body.length - 1; i >= 0; i--) {
    programFrame.childIndex = i;
    this.visit(program.body[i]);
  }

  programFrame.actions.push(['startProgram', [
    program, programFrame.childTemplateCount,
    programFrame.blankChildTextNodes.reverse()
  ]]);
  this.popFrame();

  this.programDepth--;

  // Push the completed template into the global actions list
  if (parentFrame) { parentFrame.childTemplateCount++; }
  push.apply(this.actions, programFrame.actions.reverse());
};

TemplateVisitor.prototype.ElementNode = function(element) {
  var parentFrame = this.getCurrentFrame();
  var elementFrame = this.pushFrame();
  var parentNode = parentFrame.parentNode;

  elementFrame.parentNode = element;
  elementFrame.children = element.children;
  elementFrame.childCount = element.children.length;
  elementFrame.mustacheCount += element.helpers.length;
  elementFrame.blankChildTextNodes = [];

  var actionArgs = [
    element,
    parentFrame.childIndex,
    parentFrame.childCount,
    parentNode.type === 'Program' && parentFrame.childCount === 1
  ];

  var lastNode = parentFrame.childIndex === parentFrame.childCount-1,
      introducesNamespace = elementIntroducesNamespace(element, parentFrame.parentNode);
  if ( !lastNode && introducesNamespace ) {
    elementFrame.actions.push(['setNamespace', [parentNode.namespaceURI]]);
  }
  elementFrame.actions.push(['closeElement', actionArgs]);
  if ( !lastNode && element.isHTMLIntergrationPoint ) {
    elementFrame.actions.push(['setNamespace', []]);
  }

  for (var i = element.attributes.length - 1; i >= 0; i--) {
    this.visit(element.attributes[i]);
  }

  for (i = element.children.length - 1; i >= 0; i--) {
    elementFrame.childIndex = i;
    this.visit(element.children[i]);
  }

  if ( element.isHTMLIntergrationPoint ) {
    elementFrame.actions.push(['setNamespace', []]);
  }
  elementFrame.actions.push(['openElement', actionArgs.concat([
    elementFrame.mustacheCount, elementFrame.blankChildTextNodes.reverse() ])]);
  if ( introducesNamespace ) {
    elementFrame.actions.push(['setNamespace', [element.namespaceURI]]);
  }
  this.popFrame();

  // Propagate the element's frame state to the parent frame
  if (elementFrame.mustacheCount > 0) { parentFrame.mustacheCount++; }
  parentFrame.childTemplateCount += elementFrame.childTemplateCount;
  push.apply(parentFrame.actions, elementFrame.actions);
};

TemplateVisitor.prototype.AttrNode = function(attr) {
  if (attr.value.type !== 'TextNode') {
    this.getCurrentFrame().mustacheCount++;
  }
};

TemplateVisitor.prototype.TextNode = function(text) {
  var frame = this.getCurrentFrame();
  var isSingleRoot = frame.parentNode.type === 'Program' && frame.childCount === 1;
  if (text.chars === '') {
    frame.blankChildTextNodes.push(domIndexOf(frame.children, text));
  }
  frame.actions.push(['text', [text, frame.childIndex, frame.childCount, isSingleRoot]]);
};

TemplateVisitor.prototype.BlockStatement = function(node) {
  var frame = this.getCurrentFrame();

  frame.mustacheCount++;
  frame.actions.push(['block', [node, frame.childIndex, frame.childCount]]);

  if (node.inverse) { this.visit(node.inverse); }
  if (node.program) { this.visit(node.program); }
};

TemplateVisitor.prototype.ComponentNode = function(node) {
  var frame = this.getCurrentFrame();

  frame.mustacheCount++;
  frame.actions.push(['component', [node, frame.childIndex, frame.childCount]]);

  if (node.program) { this.visit(node.program); }
};


TemplateVisitor.prototype.PartialStatement = function(node) {
  var frame = this.getCurrentFrame();
  frame.mustacheCount++;
  frame.actions.push(['mustache', [node, frame.childIndex, frame.childCount]]);
};

TemplateVisitor.prototype.CommentStatement = function(text) {
  var frame = this.getCurrentFrame();
  var isSingleRoot = frame.parentNode.type === 'Program' && frame.childCount === 1;

  frame.actions.push(['comment', [text, frame.childIndex, frame.childCount, isSingleRoot]]);
};

TemplateVisitor.prototype.MustacheStatement = function(mustache) {
  var frame = this.getCurrentFrame();
  frame.mustacheCount++;
  frame.actions.push(['mustache', [mustache, frame.childIndex, frame.childCount]]);
};

// Frame helpers

TemplateVisitor.prototype.getCurrentFrame = function() {
  return this.frameStack[this.frameStack.length - 1];
};

TemplateVisitor.prototype.pushFrame = function() {
  var frame = new Frame();
  this.frameStack.push(frame);
  return frame;
};

TemplateVisitor.prototype.popFrame = function() {
  return this.frameStack.pop();
};

export default TemplateVisitor;


// Returns the index of `domNode` in the `nodes` array, skipping
// over any nodes which do not represent DOM nodes.
function domIndexOf(nodes, domNode) {
  var index = -1;

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];

    if (node.type !== 'TextNode' && node.type !== 'ElementNode') {
      continue;
    } else {
      index++;
    }

    if (node === domNode) {
      return index;
    }
  }

  return -1;
}
