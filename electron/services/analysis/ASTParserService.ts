/**
 * AST Parser Service
 * Uses tree-sitter for fast, accurate AST parsing of TypeScript and JavaScript
 * Part of the Repository Analysis Engine
 */

import { BaseService } from '../BaseService';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  ParsedAST,
  SupportedLanguage,
  ExportedSymbol,
  ImportedSymbol,
  FunctionDefinition,
  ClassDefinition,
  TypeDefinition,
  MethodDefinition,
  PropertyDefinition,
  ParameterDefinition,
  TypePropertyDefinition,
  ASTCacheEntry,
  ASTCacheStats,
  SymbolType,
} from '../../../shared/analysis-types';

// Tree-sitter types - loaded lazily to handle Electron native module issues
// eslint-disable-next-line @typescript-eslint/no-require-imports
let Parser: typeof import('tree-sitter') | null = null;
let TypeScript: unknown = null;
let JavaScript: unknown = null;

function loadTreeSitter(): boolean {
  if (Parser !== null) return true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Parser = require('tree-sitter');

    // tree-sitter-typescript exports { typescript, tsx }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsModule = require('tree-sitter-typescript');
    TypeScript = tsModule.typescript || tsModule.default?.typescript || tsModule;

    // tree-sitter-javascript exports the language directly
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsModule = require('tree-sitter-javascript');
    JavaScript = jsModule.default || jsModule;

    console.log('[ASTParserService] Tree-sitter modules loaded successfully');
    return true;
  } catch (error) {
    // Tree-sitter is an optional native dependency. If it's not installed or fails to
    // load, we should degrade gracefully without noisy stack traces in the console.
    const message = error instanceof Error ? error.message : String(error);

    if (typeof message === 'string' && message.includes("Cannot find module 'tree-sitter'")) {
      console.warn(
        '[ASTParserService] Tree-sitter not installed; AST-based analysis is disabled. ' +
        'Install the optional dependency "tree-sitter" to enable advanced analysis features.'
      );
    } else {
      console.warn('[ASTParserService] Failed to load tree-sitter modules:', error);
    }

    Parser = null;
    return false;
  }
}

interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
  childForFieldName(name: string): TreeSitterNode | null;
  childrenForFieldName(name: string): TreeSitterNode[];
  parent: TreeSitterNode | null;
  nextSibling: TreeSitterNode | null;
  previousSibling: TreeSitterNode | null;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

export class ASTParserService extends BaseService {
  private parser: InstanceType<typeof import('tree-sitter')> | null = null;
  private tsParser: InstanceType<typeof import('tree-sitter')> | null = null;
  private jsParser: InstanceType<typeof import('tree-sitter')> | null = null;
  private cache: Map<string, ASTCacheEntry> = new Map();
  private cacheHits = 0;
  private cacheMisses = 0;
  private maxCacheSize = 500; // Max files to cache
  private initialized = false;
  private available = false; // Whether AST parsing is available

  constructor() {
    super();
  }

  /**
   * Check if AST parsing is available (tree-sitter loaded successfully)
   */
  isAvailable(): boolean {
    return this.available;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Try to load tree-sitter - gracefully degrade if it fails
    if (!loadTreeSitter() || !Parser) {
      console.warn('[ASTParserService] Tree-sitter not available - AST features disabled');
      this.available = false;
      return;
    }

    try {
      this.parser = new Parser();
      this.tsParser = new Parser();
      this.jsParser = new Parser();

      // Try setting languages - may fail with native module issues
      if (TypeScript) {
        this.tsParser.setLanguage(TypeScript);
      }
      if (JavaScript) {
        this.jsParser.setLanguage(JavaScript);
      }

      this.available = true;
      console.log('[ASTParserService] Initialized with TypeScript and JavaScript grammars');
    } catch (error) {
      console.warn('[ASTParserService] Failed to initialize languages - AST features disabled:', error);
      this.available = false;
      // Don't throw - allow app to continue without AST parsing
    }
  }

  /**
   * Parse a file and return its AST
   */
  async parseFile(filePath: string, options?: { useCache?: boolean }): Promise<ParsedAST> {
    const useCache = options?.useCache ?? true;
    const startTime = Date.now();

    // Read file content
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

    // If AST parsing is not available, return empty result
    if (!this.available) {
      const ext = path.extname(absolutePath).toLowerCase();
      const language = this.detectLanguage(ext);
      return {
        language,
        filePath: absolutePath,
        contentHash: '',
        exports: [],
        imports: [],
        functions: [],
        classes: [],
        types: [],
        parseTimeMs: 0,
      };
    }
    const content = await fs.promises.readFile(absolutePath, 'utf-8');
    const contentHash = this.hashContent(content);

    // Check cache
    if (useCache) {
      const cached = this.cache.get(absolutePath);
      if (cached && cached.contentHash === contentHash) {
        this.cacheHits++;
        cached.accessCount++;
        cached.lastAccessed = new Date().toISOString();
        return cached.ast;
      }
      this.cacheMisses++;
    }

    // Determine language
    const language = this.detectLanguage(absolutePath);
    if (!language) {
      throw new Error(`Unsupported file type: ${path.extname(absolutePath)}`);
    }

    // Parse with appropriate parser
    const parser = language === 'typescript' ? this.tsParser : this.jsParser;
    const tree: TreeSitterTree = parser.parse(content);

    // Extract AST information
    const ast: ParsedAST = {
      language,
      filePath: absolutePath,
      contentHash,
      exports: this.extractExports(tree.rootNode, language),
      imports: this.extractImports(tree.rootNode),
      functions: this.extractFunctions(tree.rootNode),
      classes: this.extractClasses(tree.rootNode),
      types: this.extractTypes(tree.rootNode),
      parseTime: Date.now() - startTime,
    };

    // Cache result
    if (useCache) {
      this.cacheAST(absolutePath, contentHash, language, ast);
    }

    return ast;
  }

  /**
   * Parse multiple files in parallel
   */
  async parseFiles(filePaths: string[], options?: { useCache?: boolean }): Promise<Map<string, ParsedAST>> {
    const results = new Map<string, ParsedAST>();

    // Process files in batches to avoid memory issues
    const batchSize = 50;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      const promises = batch.map(async (filePath) => {
        try {
          const ast = await this.parseFile(filePath, options);
          return { filePath, ast, error: null };
        } catch (error) {
          return { filePath, ast: null, error };
        }
      });

      const batchResults = await Promise.all(promises);
      for (const result of batchResults) {
        if (result.ast) {
          results.set(result.filePath, result.ast);
        }
      }
    }

    return results;
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): SupportedLanguage | null {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
        return 'javascript';
      default:
        return null;
    }
  }

  /**
   * Extract exports from AST
   */
  private extractExports(root: TreeSitterNode, language: SupportedLanguage): ExportedSymbol[] {
    const exports: ExportedSymbol[] = [];

    this.walkTree(root, (node) => {
      // Named exports: export const/function/class
      if (node.type === 'export_statement') {
        const declaration = node.childForFieldName('declaration');
        if (declaration) {
          const symbol = this.extractSymbolFromDeclaration(declaration, false);
          if (symbol) {
            exports.push(symbol);
          }
        }
        // Check for export { name } syntax
        const exportClause = node.children.find(c => c.type === 'export_clause');
        if (exportClause) {
          for (const child of exportClause.namedChildren) {
            if (child.type === 'export_specifier') {
              const name = child.childForFieldName('name')?.text || child.text;
              exports.push({
                name,
                type: 'const',
                line: child.startPosition.row + 1,
                column: child.startPosition.column,
                isDefault: false,
              });
            }
          }
        }
      }

      // Default exports: export default
      if (node.type === 'export_statement') {
        const isDefault = node.children.some(c => c.type === 'default');
        if (isDefault) {
          const value = node.childForFieldName('value') ||
                       node.childForFieldName('declaration') ||
                       node.children.find(c =>
                         c.type === 'identifier' ||
                         c.type === 'function_declaration' ||
                         c.type === 'class_declaration'
                       );
          if (value) {
            const symbol = this.extractSymbolFromDeclaration(value, true);
            if (symbol) {
              exports.push(symbol);
            }
          }
        }
      }

      // TypeScript: export interface/type
      if (language === 'typescript') {
        if (node.type === 'export_statement') {
          const declaration = node.childForFieldName('declaration');
          if (declaration) {
            if (declaration.type === 'interface_declaration') {
              const name = declaration.childForFieldName('name')?.text || 'default';
              exports.push({
                name,
                type: 'interface',
                line: declaration.startPosition.row + 1,
                column: declaration.startPosition.column,
                isDefault: false,
              });
            } else if (declaration.type === 'type_alias_declaration') {
              const name = declaration.childForFieldName('name')?.text || 'default';
              exports.push({
                name,
                type: 'type',
                line: declaration.startPosition.row + 1,
                column: declaration.startPosition.column,
                isDefault: false,
              });
            }
          }
        }
      }
    });

    return exports;
  }

  /**
   * Extract symbol from declaration node
   */
  private extractSymbolFromDeclaration(node: TreeSitterNode, isDefault: boolean): ExportedSymbol | null {
    let name: string | undefined;
    let type: SymbolType = 'const';

    switch (node.type) {
      case 'function_declaration':
      case 'function':
        name = node.childForFieldName('name')?.text;
        type = 'function';
        break;
      case 'class_declaration':
      case 'class':
        name = node.childForFieldName('name')?.text;
        type = 'class';
        break;
      case 'lexical_declaration':
      case 'variable_declaration':
        const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
        name = declarator?.childForFieldName('name')?.text;
        type = 'const';
        break;
      case 'interface_declaration':
        name = node.childForFieldName('name')?.text;
        type = 'interface';
        break;
      case 'type_alias_declaration':
        name = node.childForFieldName('name')?.text;
        type = 'type';
        break;
      case 'enum_declaration':
        name = node.childForFieldName('name')?.text;
        type = 'enum';
        break;
      case 'identifier':
        name = node.text;
        break;
    }

    if (!name && isDefault) {
      name = 'default';
    }

    if (name) {
      return {
        name,
        type,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        isDefault,
      };
    }

    return null;
  }

  /**
   * Extract imports from AST
   */
  private extractImports(root: TreeSitterNode): ImportedSymbol[] {
    const imports: ImportedSymbol[] = [];

    this.walkTree(root, (node) => {
      if (node.type === 'import_statement') {
        const source = node.childForFieldName('source')?.text?.replace(/['"]/g, '') || '';

        // Default import: import X from 'module'
        const defaultImport = node.children.find(c =>
          c.type === 'identifier' &&
          !c.parent?.children.some(s => s.type === 'import_clause')
        );
        if (defaultImport) {
          imports.push({
            name: 'default',
            alias: defaultImport.text,
            source,
            isDefault: true,
            isNamespace: false,
            line: node.startPosition.row + 1,
          });
        }

        // Named imports: import { X, Y as Z } from 'module'
        const namedImports = node.children.find(c => c.type === 'named_imports');
        if (namedImports) {
          for (const specifier of namedImports.namedChildren) {
            if (specifier.type === 'import_specifier') {
              const name = specifier.childForFieldName('name')?.text || specifier.text;
              const alias = specifier.childForFieldName('alias')?.text;
              imports.push({
                name: name.split(' ')[0], // Handle "name as alias" case
                alias,
                source,
                isDefault: false,
                isNamespace: false,
                line: node.startPosition.row + 1,
              });
            }
          }
        }

        // Namespace import: import * as X from 'module'
        const namespaceImport = node.children.find(c => c.type === 'namespace_import');
        if (namespaceImport) {
          const alias = namespaceImport.childForFieldName('alias')?.text ||
                       namespaceImport.children.find(c => c.type === 'identifier')?.text;
          imports.push({
            name: '*',
            alias,
            source,
            isDefault: false,
            isNamespace: true,
            line: node.startPosition.row + 1,
          });
        }

        // Side-effect import: import 'module'
        if (!defaultImport && !namedImports && !namespaceImport) {
          imports.push({
            name: source,
            source,
            isDefault: false,
            isNamespace: false,
            line: node.startPosition.row + 1,
          });
        }
      }
    });

    return imports;
  }

  /**
   * Extract function definitions
   */
  private extractFunctions(root: TreeSitterNode): FunctionDefinition[] {
    const functions: FunctionDefinition[] = [];

    this.walkTree(root, (node) => {
      if (node.type === 'function_declaration' ||
          node.type === 'arrow_function' ||
          node.type === 'function_expression') {

        const name = node.childForFieldName('name')?.text;
        if (!name && node.type === 'function_declaration') return;

        // Skip methods (handled in class extraction)
        if (node.parent?.type === 'method_definition') return;

        const params = this.extractParameters(node);
        const returnType = node.childForFieldName('return_type')?.text;
        const isAsync = node.children.some(c => c.type === 'async');
        const isExported = node.parent?.type === 'export_statement';

        functions.push({
          name: name || '<anonymous>',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          params,
          returnType,
          isAsync,
          isExported,
          isArrow: node.type === 'arrow_function',
        });
      }

      // Variable declarations with arrow functions
      if (node.type === 'variable_declarator') {
        const value = node.childForFieldName('value');
        if (value?.type === 'arrow_function') {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const params = this.extractParameters(value);
            const returnType = value.childForFieldName('return_type')?.text;
            const isAsync = value.children.some(c => c.type === 'async');
            const grandParent = node.parent?.parent;
            const isExported = grandParent?.type === 'export_statement';

            functions.push({
              name,
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
              endLine: value.endPosition.row + 1,
              params,
              returnType,
              isAsync,
              isExported,
              isArrow: true,
            });
          }
        }
      }
    });

    return functions;
  }

  /**
   * Extract class definitions
   */
  private extractClasses(root: TreeSitterNode): ClassDefinition[] {
    const classes: ClassDefinition[] = [];

    this.walkTree(root, (node) => {
      if (node.type === 'class_declaration' || node.type === 'class') {
        const name = node.childForFieldName('name')?.text;
        if (!name) return;

        const heritage = node.childForFieldName('heritage');
        let extendsClass: string | undefined;
        const implementsList: string[] = [];

        if (heritage) {
          for (const clause of heritage.namedChildren) {
            if (clause.type === 'extends_clause') {
              extendsClass = clause.children.find(c => c.type === 'identifier')?.text;
            }
            if (clause.type === 'implements_clause') {
              for (const impl of clause.namedChildren) {
                if (impl.type === 'type_identifier' || impl.type === 'identifier') {
                  implementsList.push(impl.text);
                }
              }
            }
          }
        }

        const body = node.childForFieldName('body');
        const methods: MethodDefinition[] = [];
        const properties: PropertyDefinition[] = [];

        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === 'method_definition') {
              const method = this.extractMethod(member);
              if (method) methods.push(method);
            }
            if (member.type === 'public_field_definition' ||
                member.type === 'field_definition' ||
                member.type === 'property_definition') {
              const prop = this.extractProperty(member);
              if (prop) properties.push(prop);
            }
          }
        }

        const isExported = node.parent?.type === 'export_statement';
        const isAbstract = node.children.some(c => c.type === 'abstract');

        classes.push({
          name,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          endLine: node.endPosition.row + 1,
          extends: extendsClass,
          implements: implementsList.length > 0 ? implementsList : undefined,
          methods,
          properties,
          isExported,
          isAbstract,
        });
      }
    });

    return classes;
  }

  /**
   * Extract method from class body
   */
  private extractMethod(node: TreeSitterNode): MethodDefinition | null {
    const name = node.childForFieldName('name')?.text;
    if (!name) return null;

    const params = this.extractParameters(node);
    const returnType = node.childForFieldName('return_type')?.text;
    const isStatic = node.children.some(c => c.type === 'static');
    const isAsync = node.children.some(c => c.type === 'async');

    let visibility: 'public' | 'private' | 'protected' = 'public';
    if (node.children.some(c => c.type === 'private')) visibility = 'private';
    if (node.children.some(c => c.type === 'protected')) visibility = 'protected';
    if (name.startsWith('#')) visibility = 'private';

    return {
      name,
      line: node.startPosition.row + 1,
      visibility,
      isStatic,
      isAsync,
      params,
      returnType,
    };
  }

  /**
   * Extract property from class body
   */
  private extractProperty(node: TreeSitterNode): PropertyDefinition | null {
    const name = node.childForFieldName('name')?.text;
    if (!name) return null;

    const type = node.childForFieldName('type')?.text;
    const isStatic = node.children.some(c => c.type === 'static');
    const isReadonly = node.children.some(c => c.type === 'readonly');

    let visibility: 'public' | 'private' | 'protected' = 'public';
    if (node.children.some(c => c.type === 'private')) visibility = 'private';
    if (node.children.some(c => c.type === 'protected')) visibility = 'protected';
    if (name.startsWith('#')) visibility = 'private';

    return {
      name,
      line: node.startPosition.row + 1,
      type,
      visibility,
      isStatic,
      isReadonly,
    };
  }

  /**
   * Extract type definitions (interfaces, type aliases, enums)
   */
  private extractTypes(root: TreeSitterNode): TypeDefinition[] {
    const types: TypeDefinition[] = [];

    this.walkTree(root, (node) => {
      if (node.type === 'interface_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (!name) return;

        const body = node.childForFieldName('body');
        const properties: TypePropertyDefinition[] = [];

        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === 'property_signature') {
              const propName = member.childForFieldName('name')?.text;
              const propType = member.childForFieldName('type')?.text;
              const optional = member.children.some(c => c.type === '?');
              if (propName) {
                properties.push({
                  name: propName,
                  type: propType || 'unknown',
                  optional,
                });
              }
            }
          }
        }

        const isExported = node.parent?.type === 'export_statement';

        types.push({
          name,
          kind: 'interface',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          isExported,
          properties,
        });
      }

      if (node.type === 'type_alias_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (!name) return;

        const isExported = node.parent?.type === 'export_statement';

        types.push({
          name,
          kind: 'type',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          isExported,
        });
      }

      if (node.type === 'enum_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (!name) return;

        const body = node.childForFieldName('body');
        const enumValues: string[] = [];

        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === 'enum_assignment') {
              const valueName = member.childForFieldName('name')?.text;
              if (valueName) enumValues.push(valueName);
            } else if (member.type === 'property_identifier') {
              enumValues.push(member.text);
            }
          }
        }

        const isExported = node.parent?.type === 'export_statement';

        types.push({
          name,
          kind: 'enum',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          isExported,
          enumValues,
        });
      }
    });

    return types;
  }

  /**
   * Extract parameters from function/method
   */
  private extractParameters(node: TreeSitterNode): ParameterDefinition[] {
    const params: ParameterDefinition[] = [];
    const parameters = node.childForFieldName('parameters');

    if (parameters) {
      for (const param of parameters.namedChildren) {
        if (param.type === 'required_parameter' ||
            param.type === 'optional_parameter' ||
            param.type === 'formal_parameters' ||
            param.type === 'identifier') {

          const name = param.childForFieldName('pattern')?.text ||
                      param.childForFieldName('name')?.text ||
                      param.text;
          const type = param.childForFieldName('type')?.text;
          const optional = param.type === 'optional_parameter' ||
                          param.children.some(c => c.type === '?');
          const defaultValue = param.childForFieldName('value')?.text;

          if (name) {
            params.push({
              name,
              type,
              optional,
              defaultValue,
            });
          }
        }
      }
    }

    return params;
  }

  /**
   * Walk tree and call callback for each node
   */
  private walkTree(node: TreeSitterNode, callback: (node: TreeSitterNode) => void): void {
    callback(node);
    for (const child of node.children) {
      this.walkTree(child, callback);
    }
  }

  /**
   * Hash file content for cache invalidation
   */
  private hashContent(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Cache parsed AST
   */
  private cacheAST(filePath: string, contentHash: string, language: SupportedLanguage, ast: ParsedAST): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const entries = Array.from(this.cache.entries())
        .sort((a, b) => new Date(a[1].lastAccessed).getTime() - new Date(b[1].lastAccessed).getTime());

      const toRemove = entries.slice(0, Math.floor(this.maxCacheSize * 0.2));
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }
    }

    const entry: ASTCacheEntry = {
      filePath,
      contentHash,
      language,
      ast,
      cachedAt: new Date().toISOString(),
      accessCount: 1,
      lastAccessed: new Date().toISOString(),
    };

    this.cache.set(filePath, entry);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): ASTCacheStats {
    const entries = Array.from(this.cache.values());
    const totalSize = JSON.stringify(entries).length;

    let oldest = entries[0]?.cachedAt;
    let newest = entries[0]?.cachedAt;

    for (const entry of entries) {
      if (entry.cachedAt < oldest) oldest = entry.cachedAt;
      if (entry.cachedAt > newest) newest = entry.cachedAt;
    }

    return {
      totalEntries: this.cache.size,
      totalSize,
      hitCount: this.cacheHits,
      missCount: this.cacheMisses,
      hitRate: this.cacheHits + this.cacheMisses > 0
        ? this.cacheHits / (this.cacheHits + this.cacheMisses)
        : 0,
      oldestEntry: oldest || '',
      newestEntry: newest || '',
    };
  }

  /**
   * Invalidate a single file's cache entry
   */
  invalidateCache(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    console.log('[ASTParserService] Cache cleared');
  }

  /**
   * Check if a file is supported for parsing
   */
  isSupported(filePath: string): boolean {
    return this.detectLanguage(filePath) !== null;
  }

  /**
   * Get supported file extensions
   */
  getSupportedExtensions(): string[] {
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  }

  async dispose(): Promise<void> {
    this.clearCache();
  }
}
