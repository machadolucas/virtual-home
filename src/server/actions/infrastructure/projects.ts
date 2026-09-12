"use server";

import { bindOperation } from "@/server/operations/web";
import * as operations from "@/server/operations/infrastructure/projects";

export const createProject = bindOperation(operations.createProject, false);
export const updateProject = bindOperation(operations.updateProject, false);
export const deleteProject = bindOperation(operations.deleteProject, true);
export const addProjectLink = bindOperation(operations.addProjectLink, false);
export const removeProjectLink = bindOperation(operations.removeProjectLink, false);
export const addProjectAttachment = bindOperation(operations.addProjectAttachment, false);
export const removeProjectAttachment = bindOperation(operations.removeProjectAttachment, false);
