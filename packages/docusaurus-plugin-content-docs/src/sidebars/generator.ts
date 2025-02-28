/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  SidebarItemDoc,
  SidebarItemsGenerator,
  SidebarItemsGeneratorDoc,
  NormalizedSidebarItemCategory,
  NormalizedSidebarItem,
  SidebarItemCategoryLinkConfig,
} from './types';
import _ from 'lodash';
import {addTrailingSlash, posixPath} from '@docusaurus/utils';
import logger from '@docusaurus/logger';
import path from 'path';
import {createDocsByIdIndex, toCategoryIndexMatcherParam} from '../docs';

const BreadcrumbSeparator = '/';

// Just an alias to the make code more explicit
function getLocalDocId(docId: string): string {
  return _.last(docId.split('/'))!;
}

export const CategoryMetadataFilenameBase = '_category_';
export const CategoryMetadataFilenamePattern = '_category_.{json,yml,yaml}';

type WithPosition<T> = T & {
  position?: number;
  /** The source is the file/folder name */
  source?: string;
};

/**
 * A representation of the fs structure. For each object entry:
 * If it's a folder, the key is the directory name, and value is the directory
 * content; If it's a doc file, the key is the doc's source file name, and value
 * is the doc ID
 */
type Dir = {
  [item: string]: Dir | string;
};

// Comment for this feature: https://github.com/facebook/docusaurus/issues/3464#issuecomment-818670449
export const DefaultSidebarItemsGenerator: SidebarItemsGenerator = async ({
  numberPrefixParser,
  isCategoryIndex,
  docs: allDocs,
  item: {dirName: autogenDir},
  categoriesMetadata,
}) => {
  const docsById = createDocsByIdIndex(allDocs);
  const findDoc = (docId: string): SidebarItemsGeneratorDoc | undefined =>
    docsById[docId];
  const getDoc = (docId: string): SidebarItemsGeneratorDoc => {
    const doc = findDoc(docId);
    if (!doc) {
      throw new Error(
        `Can't find any doc with id=${docId}.\nAvailable doc ids:\n- ${Object.keys(
          docsById,
        ).join('\n- ')}`,
      );
    }
    return doc;
  };

  /**
   * Step 1. Extract the docs that are in the autogen dir.
   */
  function getAutogenDocs(): SidebarItemsGeneratorDoc[] {
    function isInAutogeneratedDir(doc: SidebarItemsGeneratorDoc) {
      return (
        // Doc at the root of the autogenerated sidebar dir
        doc.sourceDirName === autogenDir ||
        // autogen dir is . and doc is in subfolder
        autogenDir === '.' ||
        // autogen dir is not . and doc is in subfolder
        // "api/myDoc" startsWith "api/" (note "api2/myDoc" is not included)
        doc.sourceDirName.startsWith(addTrailingSlash(autogenDir))
      );
    }
    const docs = allDocs.filter(isInAutogeneratedDir);

    if (docs.length === 0) {
      logger.warn`No docs found in path=${autogenDir}: can't auto-generate a sidebar.`;
    }
    return docs;
  }

  /**
   * Step 2. Turn the linear file list into a tree structure.
   */
  function treeify(docs: SidebarItemsGeneratorDoc[]): Dir {
    // Get the category breadcrumb of a doc (relative to the dir of the
    // autogenerated sidebar item)
    // autogenDir=a/b and docDir=a/b/c/d => returns [c, d]
    // autogenDir=a/b and docDir=a/b => returns []
    // TODO: try to use path.relative()
    function getRelativeBreadcrumb(doc: SidebarItemsGeneratorDoc): string[] {
      return autogenDir === doc.sourceDirName
        ? []
        : doc.sourceDirName
            .replace(addTrailingSlash(autogenDir), '')
            .split(BreadcrumbSeparator);
    }
    const treeRoot: Dir = {};
    docs.forEach((doc) => {
      const breadcrumb = getRelativeBreadcrumb(doc);
      // We walk down the file's path to generate the fs structure
      let currentDir = treeRoot;
      breadcrumb.forEach((dir) => {
        if (typeof currentDir[dir] === 'undefined') {
          currentDir[dir] = {}; // Create new folder.
        }
        currentDir = currentDir[dir] as Dir; // Go into the subdirectory.
      });
      // We've walked through the path. Register the file in this directory.
      currentDir[path.basename(doc.source)] = doc.id;
    });
    return treeRoot;
  }

  /**
   * Step 3. Recursively transform the tree-like structure to sidebar items.
   * (From a record to an array of items, akin to normalizing shorthand)
   */
  function generateSidebar(
    fsModel: Dir,
  ): WithPosition<NormalizedSidebarItem>[] {
    function createDocItem(
      id: string,
      fullPath: string,
      fileName: string,
    ): WithPosition<SidebarItemDoc> {
      const {
        sidebarPosition: position,
        frontMatter: {sidebar_label: label, sidebar_class_name: className},
      } = getDoc(id);
      return {
        type: 'doc',
        id,
        position,
        source: fileName,
        // We don't want these fields to magically appear in the generated
        // sidebar
        ...(label !== undefined && {label}),
        ...(className !== undefined && {className}),
      };
    }
    function createCategoryItem(
      dir: Dir,
      fullPath: string,
      folderName: string,
    ): WithPosition<NormalizedSidebarItemCategory> {
      const categoryMetadata =
        categoriesMetadata[posixPath(path.join(autogenDir, fullPath))];
      const className = categoryMetadata?.className;
      const {filename, numberPrefix} = numberPrefixParser(folderName);
      const allItems = Object.entries(dir).map(([key, content]) =>
        dirToItem(content, key, `${fullPath}/${key}`),
      );

      // Try to match a doc inside the category folder,
      // using the "local id" (myDoc) or "qualified id" (dirName/myDoc)
      function findDocByLocalId(localId: string): SidebarItemDoc | undefined {
        return allItems.find(
          (item): item is SidebarItemDoc =>
            item.type === 'doc' && getLocalDocId(item.id) === localId,
        );
      }

      function findConventionalCategoryDocLink(): SidebarItemDoc | undefined {
        return allItems.find((item): item is SidebarItemDoc => {
          if (item.type !== 'doc') {
            return false;
          }
          const doc = getDoc(item.id);
          return isCategoryIndex(toCategoryIndexMatcherParam(doc));
        });
      }

      function getCategoryLinkedDocId(): string | undefined {
        const link = categoryMetadata?.link;
        if (link !== undefined) {
          if (link && link.type === 'doc') {
            return findDocByLocalId(link.id)?.id || getDoc(link.id).id;
          }
          // If a link is explicitly specified, we won't apply conventions
          return undefined;
        }
        // Apply default convention to pick index.md, README.md or
        // <categoryName>.md as the category doc
        return findConventionalCategoryDocLink()?.id;
      }

      const categoryLinkedDocId = getCategoryLinkedDocId();

      const link: SidebarItemCategoryLinkConfig | null | undefined =
        categoryLinkedDocId
          ? {
              type: 'doc',
              id: categoryLinkedDocId, // We "remap" a potentially "local id" to a "qualified id"
            }
          : categoryMetadata?.link;

      // If a doc is linked, remove it from the category subItems
      const items = allItems.filter(
        (item) => !(item.type === 'doc' && item.id === categoryLinkedDocId),
      );

      return {
        type: 'category',
        label: categoryMetadata?.label ?? filename,
        collapsible: categoryMetadata?.collapsible,
        collapsed: categoryMetadata?.collapsed,
        position: categoryMetadata?.position ?? numberPrefix,
        source: folderName,
        ...(className !== undefined && {className}),
        items,
        ...(link && {link}),
      };
    }
    function dirToItem(
      dir: Dir | string, // The directory item to be transformed.
      itemKey: string, // File/folder name; for categories, it's used to generate the next `relativePath`.
      fullPath: string, // `dir`'s full path relative to the autogen dir.
    ): WithPosition<NormalizedSidebarItem> {
      return typeof dir === 'object'
        ? createCategoryItem(dir, fullPath, itemKey)
        : createDocItem(dir, fullPath, itemKey);
    }
    return Object.entries(fsModel).map(([key, content]) =>
      dirToItem(content, key, key),
    );
  }

  /**
   * Step 4. Recursively sort the categories/docs + remove the "position"
   * attribute from final output. Note: the "position" is only used to sort
   * "inside" a sidebar slice. It is not used to sort across multiple
   * consecutive sidebar slices (i.e. a whole category composed of multiple
   * autogenerated items)
   */
  function sortItems(
    sidebarItems: WithPosition<NormalizedSidebarItem>[],
  ): NormalizedSidebarItem[] {
    const processedSidebarItems = sidebarItems.map((item) => {
      if (item.type === 'category') {
        return {...item, items: sortItems(item.items)};
      }
      return item;
    });
    const sortedSidebarItems = _.sortBy(processedSidebarItems, [
      'position',
      'source',
    ]);
    return sortedSidebarItems.map(({position, source, ...item}) => item);
  }
  // TODO: the whole code is designed for pipeline operator
  const docs = getAutogenDocs();
  const fsModel = treeify(docs);
  const sidebarWithPosition = generateSidebar(fsModel);
  const sortedSidebar = sortItems(sidebarWithPosition);
  return sortedSidebar;
};
