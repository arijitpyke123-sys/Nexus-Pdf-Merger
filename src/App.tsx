import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { Document, Packer, Paragraph, ImageRun } from 'docx';
import * as fabric from 'fabric';
import { GoogleGenAI } from '@google/genai';
import Markdown from 'react-markdown';
import { UploadCloud, FileDown, Trash2, GripVertical, FilePlus2, Loader2, Layers, X, Eye, ArrowDown, Zap, ChevronRight, RotateCw, FileText, MousePointer2, Pen, Type, Eraser, Undo2, Redo2, Sparkles, MessageSquareText } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { motion, AnimatePresence, useMotionValue, useSpring } from 'motion/react';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp, 
  handleFirestoreError, 
  OperationType,
  deleteDoc,
  doc,
  User,
  Timestamp
} from './firebase';

// Configure PDF.js worker using Vite's URL import
// @ts-ignore
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Utility for Tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Types
type SourceFile = {
  id: string;
  name: string;
  file: File;
};

type PageMeta = {
  id: string; // Unique ID for the grid item
  sourceFileId: string;
  sourceFileName: string;
  originalPageIndex: number;
  thumbnailDataUrl: string;
  rotation?: number; // 0, 90, 180, 270
  annotationsImage?: string; // Base64 PNG of annotations
  extractedText?: string; // AI extracted text
};

// --- Components ---

function SortablePage({
  page,
  index,
  onRemove,
  onPreview,
}: {
  key?: React.Key;
  page: PageMeta;
  index: number;
  onRemove: (id: string) => void;
  onPreview: (page: PageMeta) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: page.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative group flex flex-col bg-[#1e2128] rounded-xl border border-white/10 shadow-lg overflow-hidden transition-all duration-200 w-40 h-56",
        isDragging ? "opacity-80 scale-105 shadow-2xl border-[#ff6d5a] ring-2 ring-[#ff6d5a]/50" : "hover:border-white/30 hover:shadow-xl"
      )}
    >
      <motion.div 
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.3) }}
        className="absolute inset-0 flex flex-col"
      >
        {/* Thumbnail */}
        <div 
          className="flex-1 bg-white/5 p-2 flex items-center justify-center overflow-hidden relative"
        >
          <img
            src={page.thumbnailDataUrl}
            alt={`Page ${index + 1}`}
            className="max-w-full max-h-full object-contain shadow-sm bg-white transition-transform duration-300"
            style={{ transform: `rotate(${page.rotation || 0}deg)` }}
          />
          <div className="absolute inset-0 bg-[#0f111a]/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px] pointer-events-none">
            <Eye className="w-8 h-8 text-white drop-shadow-lg" />
          </div>
        </div>

        {/* Footer */}
        <div className="h-10 px-3 bg-[#15171c] border-t border-white/5 flex items-center justify-between text-[10px] text-white/60 font-mono pointer-events-none">
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center text-white/80">
              {index + 1}
            </div>
          </div>
          <div className="flex flex-col items-end truncate ml-2">
            <span className="truncate w-full text-right" title={page.sourceFileName}>
              {page.sourceFileName}
            </span>
            <span className="text-white/40">Pg {page.originalPageIndex + 1}</span>
          </div>
        </div>
      </motion.div>

      {/* Drag Handle Area */}
      <div
        {...attributes}
        {...listeners}
        onClick={(e) => {
          e.stopPropagation();
          onPreview(page);
        }}
        className="absolute inset-0 z-10 cursor-grab active:cursor-grabbing"
      />

      {/* Delete Button - higher z-index to be clickable */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(page.id);
        }}
        className="absolute top-2 right-2 p-1.5 bg-red-500/80 hover:bg-red-500 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-20"
        title="Remove page"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function PreviewModal({
  pageMeta,
  sourceFiles,
  onClose,
  onRotate,
  onDelete,
  onSaveAnnotations,
  onSaveExtractedText,
}: {
  pageMeta: PageMeta;
  sourceFiles: SourceFile[];
  onClose: () => void;
  onRotate: (id: string, degrees: number) => void;
  onDelete: (id: string) => void;
  onSaveAnnotations: (id: string, dataUrl: string) => void;
  onSaveExtractedText: (id: string, text: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricInstance = useRef<fabric.Canvas | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setModeState] = useState<'select' | 'draw' | 'text'>('select');
  const modeRef = useRef(mode);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const isHistoryUpdate = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const [showAIPanel, setShowAIPanel] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiText, setAiText] = useState(pageMeta.extractedText || '');

  const updateHistoryState = useCallback(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
  }, []);

  const saveHistory = useCallback(() => {
    if (!fabricInstance.current || isHistoryUpdate.current) return;
    const json = JSON.stringify(fabricInstance.current.toJSON());
    const newHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    newHistory.push(json);
    historyRef.current = newHistory;
    historyIndexRef.current = newHistory.length - 1;
    updateHistoryState();
  }, [updateHistoryState]);

  const handleUndo = async () => {
    if (historyIndexRef.current > 0 && fabricInstance.current) {
      isHistoryUpdate.current = true;
      historyIndexRef.current -= 1;
      await fabricInstance.current.loadFromJSON(JSON.parse(historyRef.current[historyIndexRef.current]));
      fabricInstance.current.renderAll();
      isHistoryUpdate.current = false;
      updateHistoryState();
    }
  };

  const handleRedo = async () => {
    if (historyIndexRef.current < historyRef.current.length - 1 && fabricInstance.current) {
      isHistoryUpdate.current = true;
      historyIndexRef.current += 1;
      await fabricInstance.current.loadFromJSON(JSON.parse(historyRef.current[historyIndexRef.current]));
      fabricInstance.current.renderAll();
      isHistoryUpdate.current = false;
      updateHistoryState();
    }
  };

  const setMode = (newMode: 'select' | 'draw' | 'text') => {
    setModeState(newMode);
    modeRef.current = newMode;
    if (fabricInstance.current) {
      fabricInstance.current.isDrawingMode = newMode === 'draw';
    }
  };

  useEffect(() => {
    let isCancelled = false;
    const renderPage = async () => {
      try {
        setLoading(true);
        const sourceFile = sourceFiles.find(f => f.id === pageMeta.sourceFileId);
        if (!sourceFile) return;
        const arrayBuffer = await sourceFile.file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        const page = await pdf.getPage(pageMeta.originalPageIndex + 1);
        
        if (isCancelled) return;

        const currentRotation = pageMeta.rotation || 0;
        const viewport = page.getViewport({ scale: 2.0, rotation: page.rotate + currentRotation });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        setDimensions({ width: viewport.width, height: viewport.height });

        await page.render({ canvasContext: context, canvas: canvas, viewport }).promise;
        if (!isCancelled) setLoading(false);
      } catch (e) {
        console.error("Error rendering preview:", e);
        if (!isCancelled) setLoading(false);
      }
    };
    renderPage();
    return () => {
      isCancelled = true;
    };
  }, [pageMeta, sourceFiles]);

  useEffect(() => {
    const handleResize = () => {
      if (fabricInstance.current) {
        fabricInstance.current.calcOffset();
      }
    };

    if (!loading && dimensions.width > 0 && fabricCanvasRef.current && !fabricInstance.current) {
      const canvas = new fabric.Canvas(fabricCanvasRef.current, {
        width: dimensions.width,
        height: dimensions.height,
        isDrawingMode: false,
      });
      
      const brush = new fabric.PencilBrush(canvas);
      brush.color = '#ff6d5a';
      brush.width = 5;
      canvas.freeDrawingBrush = brush;
      
      fabricInstance.current = canvas;

      // Ensure the fabric container is correctly positioned and responsive
      const container = canvas.getElement().parentElement;
      if (container) {
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        
        const lowerCanvas = container.querySelector('.lower-canvas') as HTMLCanvasElement;
        const upperCanvas = container.querySelector('.upper-canvas') as HTMLCanvasElement;
        if (lowerCanvas) { 
          lowerCanvas.style.width = '100%'; 
          lowerCanvas.style.height = '100%'; 
        }
        if (upperCanvas) { 
          upperCanvas.style.width = '100%'; 
          upperCanvas.style.height = '100%'; 
        }
      }

      canvas.calcOffset();
      window.addEventListener('resize', handleResize);
      
      if (pageMeta.annotationsImage) {
        isHistoryUpdate.current = true;
        fabric.Image.fromURL(pageMeta.annotationsImage).then((img) => {
          canvas.add(img);
          canvas.renderAll();
          isHistoryUpdate.current = false;
          saveHistory();
        });
      } else {
        saveHistory();
      }

      canvas.on('object:added', saveHistory);
      canvas.on('object:modified', saveHistory);
      canvas.on('object:removed', saveHistory);

      canvas.on('mouse:down', (options) => {
        if (modeRef.current === 'text' && !options.target) {
          const pointer = canvas.getScenePoint(options.e);
          const text = new fabric.Textbox('Type here', {
            left: pointer.x,
            top: pointer.y,
            width: 250,
            fontFamily: 'Helvetica',
            fill: '#ff6d5a',
            fontSize: 40,
            originX: 'left',
            originY: 'top',
            cornerSize: 12,
            transparentCorners: false,
            cornerColor: '#ff6d5a',
            borderColor: '#ff6d5a',
            cornerStrokeColor: '#ffffff',
          });
          canvas.add(text);
          canvas.setActiveObject(text);
          canvas.renderAll();
          text.enterEditing();
          text.selectAll();
          setMode('select');
        }
      });
    }
    
    return () => {
      window.removeEventListener('resize', handleResize);
      if (fabricInstance.current) {
        fabricInstance.current.off('object:added', saveHistory);
        fabricInstance.current.off('object:modified', saveHistory);
        fabricInstance.current.off('object:removed', saveHistory);
        fabricInstance.current.dispose();
        fabricInstance.current = null;
      }
    };
  }, [loading, dimensions, pageMeta.annotationsImage, saveHistory]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && fabricInstance.current) {
        const activeObject = fabricInstance.current.getActiveObject();
        // @ts-ignore
        if (activeObject && activeObject.isEditing) return;
        
        const activeObjects = fabricInstance.current.getActiveObjects();
        if (activeObjects.length > 0) {
          fabricInstance.current.remove(...activeObjects);
          fabricInstance.current.discardActiveObject();
          fabricInstance.current.renderAll();
          saveHistory();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveHistory]);

  const handleClose = () => {
    if (fabricInstance.current) {
      const objects = fabricInstance.current.getObjects();
      if (objects.length > 0) {
        const dataUrl = fabricInstance.current.toDataURL({
          format: 'png',
          multiplier: 1,
        });
        onSaveAnnotations(pageMeta.id, dataUrl);
      } else {
        onSaveAnnotations(pageMeta.id, '');
      }
    }
    onSaveExtractedText(pageMeta.id, aiText);
    onClose();
  };

  const handleExtractText = async () => {
    if (!canvasRef.current) return;
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing. Please configure it in your environment variables.");
      setAiText("Error: Gemini API key is not configured. If you are the developer, please add GEMINI_API_KEY to your environment variables.");
      setShowAIPanel(true);
      return;
    }

    setAiLoading(true);
    setShowAIPanel(true);
    try {
      const ai = new GoogleGenAI({ apiKey });
      const base64Image = canvasRef.current.toDataURL('image/jpeg', 0.95);
      const base64Data = base64Image.split(',')[1];
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: 'image/jpeg',
              },
            },
            {
              text: 'Provide a concise summary of this page. If there are visuals, describe their significance. Return the result as clean markdown.',
            },
          ],
        },
      });
      
      setAiText(response.text || 'No summary could be generated.');
    } catch (error: any) {
      console.error("Error extracting text:", error);
      let errorMessage = "Failed to extract text. Please try again.";
      if (error.message?.includes('API_KEY_INVALID')) {
        errorMessage = "Invalid API Key. Please check your configuration.";
      } else if (error.message?.includes('quota')) {
        errorMessage = "API quota exceeded. Please try again later.";
      }
      setAiText(errorMessage);
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] bg-[#0f111a]/90 backdrop-blur-md flex items-center justify-center p-4 md:p-8"
      onClick={handleClose}
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 20 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="relative bg-[#1e2128] rounded-2xl border border-white/10 shadow-2xl flex flex-col max-h-full max-w-full overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10 bg-[#15171c]">
          <h3 className="text-white font-medium truncate pr-4">
            {pageMeta.sourceFileName} - Page {pageMeta.originalPageIndex + 1}
          </h3>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 mr-4 bg-white/5 p-1 rounded-lg">
              <button 
                onClick={() => {
                  setMode('select');
                  if (fabricInstance.current) fabricInstance.current.isDrawingMode = false;
                }}
                className={cn("p-1.5 rounded-md transition-colors", mode === 'select' ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white")}
                title="Select"
              >
                <MousePointer2 className="w-4 h-4" />
              </button>
              <button 
                onClick={() => {
                  setMode('draw');
                  if (fabricInstance.current) fabricInstance.current.isDrawingMode = true;
                }}
                className={cn("p-1.5 rounded-md transition-colors", mode === 'draw' ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white")}
                title="Draw"
              >
                <Pen className="w-4 h-4" />
              </button>
              <button 
                onClick={() => {
                  setMode('text');
                }}
                className={cn("p-1.5 rounded-md transition-colors", mode === 'text' ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white")}
                title="Add Text (Click on canvas)"
              >
                <Type className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-white/10 mx-1" />
              <button 
                onClick={handleUndo}
                disabled={!canUndo}
                className="p-1.5 rounded-md text-white/60 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                title="Undo"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button 
                onClick={handleRedo}
                disabled={!canRedo}
                className="p-1.5 rounded-md text-white/60 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                title="Redo"
              >
                <Redo2 className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-white/10 mx-1" />
              <button 
                onClick={() => {
                  if (fabricInstance.current) {
                    const activeObjects = fabricInstance.current.getActiveObjects();
                    if (activeObjects.length > 0) {
                      fabricInstance.current.remove(...activeObjects);
                      fabricInstance.current.discardActiveObject();
                      fabricInstance.current.renderAll();
                      saveHistory();
                    }
                  }
                }}
                className="p-1.5 rounded-md text-white/60 hover:bg-white/10 hover:text-white transition-colors"
                title="Delete Selected (Del/Backspace)"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button 
                onClick={() => {
                  if (fabricInstance.current) {
                    fabricInstance.current.clear();
                    fabricInstance.current.backgroundColor = 'transparent';
                    saveHistory();
                  }
                }}
                className="p-1.5 rounded-md text-white/60 hover:bg-white/10 hover:text-white transition-colors"
                title="Clear All Annotations"
              >
                <Eraser className="w-4 h-4" />
              </button>
            </div>

            <button 
              onClick={() => onRotate(pageMeta.id, 90)}
              className="p-1.5 hover:bg-white/10 rounded-lg text-white/60 hover:text-white transition-colors"
              title="Rotate 90°"
            >
              <RotateCw className="w-5 h-5" />
            </button>
            <button 
              onClick={() => {
                if (!showAIPanel && !aiText) {
                  handleExtractText();
                } else {
                  setShowAIPanel(!showAIPanel);
                }
              }}
              className={cn("p-1.5 rounded-lg transition-colors flex items-center gap-1.5", showAIPanel ? "bg-[#ff6d5a]/20 text-[#ff6d5a]" : "hover:bg-[#ff6d5a]/10 text-white/60 hover:text-[#ff6d5a]")}
              title="AI Page Summary"
            >
              <Sparkles className="w-5 h-5" />
            </button>
            <button 
              onClick={() => {
                onDelete(pageMeta.id);
                handleClose();
              }}
              className="p-1.5 hover:bg-red-500/20 rounded-lg text-white/60 hover:text-red-500 transition-colors"
              title="Delete Page"
            >
              <Trash2 className="w-5 h-5" />
            </button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button 
              onClick={handleClose}
              className="p-1.5 hover:bg-white/10 rounded-lg text-white/60 hover:text-white transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 flex overflow-hidden bg-black/20 min-w-[300px] min-h-[300px]">
          <div className="flex-1 overflow-auto p-4 flex flex-col">
            <div className="m-auto relative flex items-center justify-center max-w-full">
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                  <Loader2 className="w-8 h-8 text-[#ff6d5a] animate-spin" />
                </div>
              )}
              <div 
                className="relative shadow-xl bg-white" 
                style={{ 
                  display: loading ? 'none' : 'block',
                  width: '100%',
                  maxWidth: dimensions.width ? `${dimensions.width}px` : 'none',
                  aspectRatio: dimensions.width && dimensions.height ? `${dimensions.width} / ${dimensions.height}` : 'auto',
                }}
              >
                <canvas 
                  ref={canvasRef} 
                  className="w-full h-full block"
                />
                <canvas
                  ref={fabricCanvasRef}
                  className="absolute top-0 left-0 w-full h-full block"
                />
              </div>
            </div>
          </div>
          
          <AnimatePresence>
            {showAIPanel && (
              <motion.div 
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 320, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                className="border-l border-white/10 bg-[#15171c] flex flex-col"
              >
                <div className="p-4 border-b border-white/10 flex items-center justify-between">
                  <h4 className="text-white font-medium flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[#ff6d5a]" />
                    AI Page Summary
                  </h4>
                  <button 
                    onClick={() => setShowAIPanel(false)}
                    className="text-white/60 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 p-4 flex flex-col gap-4 overflow-hidden">
                  {aiLoading ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-white/60 gap-3">
                      <Loader2 className="w-6 h-6 animate-spin text-[#ff6d5a]" />
                      <p className="text-sm">Summarizing page...</p>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col gap-2 overflow-hidden">
                      <p className="text-xs text-white/60">
                        AI-generated summary of this page.
                      </p>
                      <div className="flex-1 bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white/90 overflow-y-auto markdown-body">
                        <Markdown>{aiText}</Markdown>
                      </div>
                    </div>
                  )}
                  {!aiLoading && (
                    <button
                      onClick={handleExtractText}
                      className="w-full py-2 bg-white/5 hover:bg-white/10 text-white rounded-lg text-sm transition-colors border border-white/10"
                    >
                      Regenerate
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SummaryModal({
  summary,
  onClose,
  onRegenerate,
  loading,
}: {
  summary: string;
  onClose: () => void;
  onRegenerate: () => void;
  loading: boolean;
}) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] bg-[#0f111a]/90 backdrop-blur-md flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 20 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="bg-[#1e2128] border border-white/10 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-white/10 bg-[#15171c] flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#ff6d5a]" />
            Document Summary
          </h3>
          <button onClick={onClose} className="text-white/60 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 markdown-body text-white/90">
          {loading ? (
            <div className="h-full flex flex-col items-center justify-center gap-4 py-12">
              <Loader2 className="w-10 h-10 text-[#ff6d5a] animate-spin" />
              <p className="text-white/60">Analyzing entire document and generating summary...</p>
            </div>
          ) : (
            <Markdown>{summary || "No summary available."}</Markdown>
          )}
        </div>

        <div className="p-4 border-t border-white/10 bg-[#15171c] flex justify-end gap-3">
          <button 
            onClick={onRegenerate}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors border border-white/10 disabled:opacity-50"
          >
            Regenerate
          </button>
          <button 
            onClick={onClose}
            className="px-6 py-2 text-sm font-medium bg-[#ff6d5a] hover:bg-[#ff5a45] text-white rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ReviewSection() {
  const [reviews, setReviews] = useState<any[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [newComment, setNewComment] = useState('');
  const [rating, setRating] = useState(5);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });

    const q = query(collection(db, 'reviews'), orderBy('createdAt', 'desc'));
    const unsubscribeSnap = onSnapshot(q, (snapshot) => {
      const reviewsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setReviews(reviewsData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'reviews');
    });

    return () => {
      unsubscribeAuth();
      unsubscribeSnap();
    };
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newComment.trim()) return;

    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'reviews'), {
        uid: user.uid,
        userName: user.displayName || 'Anonymous',
        userPhoto: user.photoURL || '',
        rating,
        comment: newComment.trim(),
        createdAt: serverTimestamp(),
      });
      setNewComment('');
      setRating(5);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'reviews');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteReview = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'reviews', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `reviews/${id}`);
    }
  };

  return (
    <section className="w-full max-w-4xl mx-auto py-20 px-6 border-t border-white/10">
      <div className="text-center mb-12">
        <h2 className="text-3xl font-bold mb-4">User Reviews</h2>
        <p className="text-white/60">Share your experience with Nexus PDF</p>
      </div>

      {/* Review Form */}
      <div className="bg-[#1e2128] rounded-2xl border border-white/10 p-6 mb-12 shadow-xl">
        {user ? (
          <form onSubmit={handleSubmitReview} className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img src={user.photoURL || ''} alt="" className="w-10 h-10 rounded-full border border-white/10" referrerPolicy="no-referrer" />
                <div>
                  <div className="text-sm font-medium text-white">{user.displayName}</div>
                  <button type="button" onClick={handleLogout} className="text-[10px] text-white/40 hover:text-white transition-colors">Sign Out</button>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setRating(star)}
                    className={cn("p-1 transition-colors", rating >= star ? "text-yellow-400" : "text-white/20")}
                  >
                    <Sparkles className="w-5 h-5 fill-current" />
                  </button>
                ))}
              </div>
            </div>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Write your review here..."
              className="w-full bg-white/5 border border-white/10 rounded-xl p-4 text-sm text-white/90 focus:outline-none focus:ring-1 focus:ring-[#ff6d5a] min-h-[100px] resize-none"
              maxLength={1000}
              required
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSubmitting || !newComment.trim()}
                className="px-6 py-2 bg-[#ff6d5a] hover:bg-[#ff5a45] text-white rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-2"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquareText className="w-4 h-4" />}
                Post Review
              </button>
            </div>
          </form>
        ) : (
          <div className="text-center py-8">
            <p className="text-white/60 mb-6">Sign in with Google to leave a review</p>
            <button
              onClick={handleLogin}
              className="px-8 py-3 bg-white text-black rounded-xl font-medium hover:bg-white/90 transition-all flex items-center gap-3 mx-auto"
            >
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" className="w-5 h-5" />
              Continue with Google
            </button>
          </div>
        )}
      </div>

      {/* Reviews List */}
      <div className="space-y-6">
        <AnimatePresence mode="popLayout">
          {reviews.map((review) => (
            <motion.div
              key={review.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-[#15171c] rounded-xl border border-white/5 p-6 relative group"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <img src={review.userPhoto} alt="" className="w-10 h-10 rounded-full border border-white/10" referrerPolicy="no-referrer" />
                  <div>
                    <div className="text-sm font-medium text-white">{review.userName}</div>
                    <div className="text-[10px] text-white/40">
                      {review.createdAt instanceof Timestamp ? review.createdAt.toDate().toLocaleDateString() : 'Just now'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Sparkles
                      key={star}
                      className={cn("w-3.5 h-3.5 fill-current", review.rating >= star ? "text-yellow-400" : "text-white/10")}
                    />
                  ))}
                </div>
              </div>
              <p className="text-sm text-white/70 leading-relaxed italic">"{review.comment}"</p>
              
              {user && user.uid === review.uid && (
                <button
                  onClick={() => handleDeleteReview(review.id)}
                  className="absolute top-4 right-4 p-2 text-white/20 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                  title="Delete Review"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        
        {reviews.length === 0 && (
          <div className="text-center py-12 text-white/20 italic">
            No reviews yet. Be the first to share your thoughts!
          </div>
        )}
      </div>
    </section>
  );
}

// --- Main App ---

export default function App() {
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addPageNumbers, setAddPageNumbers] = useState(false);
  const [previewPage, setPreviewPage] = useState<PageMeta | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [docSummary, setDocSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Orb animation state
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const orbX = useSpring(mouseX, { damping: 40, stiffness: 150, mass: 0.8 });
  const orbY = useSpring(mouseY, { damping: 40, stiffness: 150, mass: 0.8 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Offset by half the orb size (300px for a 600px orb)
      mouseX.set(e.pageX - 300);
      mouseY.set(e.pageY - 300);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [mouseX, mouseY]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 5px movement before drag starts
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      setPages((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const processFile = async (file: File) => {
    setIsProcessing(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const fileId = Math.random().toString(36).substring(7);

      setSourceFiles((prev) => [...prev, { id: fileId, name: file.name, file }]);

      // Load with pdfjs to generate thumbnails
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
      const pdf = await loadingTask.promise;
      const numPages = pdf.numPages;

      const newPages: PageMeta[] = [];

      for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        // Render a small thumbnail for performance
        const viewport = page.getViewport({ scale: 1.0 });
        const scale = 200 / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) continue;

        canvas.height = scaledViewport.height;
        canvas.width = scaledViewport.width;

        const renderContext = {
          canvasContext: context,
          canvas: canvas,
          viewport: scaledViewport,
        };

        await page.render(renderContext).promise;
        const thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.7);

        newPages.push({
          id: `${fileId}-page-${i}`,
          sourceFileId: fileId,
          sourceFileName: file.name,
          originalPageIndex: i - 1, // 0-indexed for pdf-lib
          thumbnailDataUrl,
        });
      }

      setPages((prev) => [...prev, ...newPages]);
    } catch (error) {
      console.error("Error processing PDF:", error);
      setAlertMessage(`Failed to process ${file.name}. Please ensure it's a valid PDF file.`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    
    if (pdfFiles.length === 0) {
      setAlertMessage("Please select valid PDF files.");
      return;
    }

    // Process files sequentially to avoid overwhelming the browser
    const processSequentially = async () => {
      for (const file of pdfFiles) {
        await processFile(file);
      }
    };
    
    processSequentially();
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemovePage = (id: string) => {
    setPages((prev) => prev.filter((p) => p.id !== id));
  };

  const handleRotatePage = (id: string, degrees: number) => {
    setPages((prev) => prev.map(p => {
      if (p.id === id) {
        return { ...p, rotation: ((p.rotation || 0) + degrees) % 360 };
      }
      return p;
    }));
    setPreviewPage(prev => {
      if (prev && prev.id === id) {
        return { ...prev, rotation: ((prev.rotation || 0) + degrees) % 360 };
      }
      return prev;
    });
  };

  const handleSaveAnnotations = (id: string, dataUrl: string) => {
    setPages((prev) => prev.map(p => {
      if (p.id === id) {
        return { ...p, annotationsImage: dataUrl };
      }
      return p;
    }));
    setPreviewPage(prev => {
      if (prev && prev.id === id) {
        return { ...prev, annotationsImage: dataUrl };
      }
      return prev;
    });
  };

  const handleSaveExtractedText = (id: string, text: string) => {
    setPages((prev) => prev.map(p => {
      if (p.id === id) {
        return { ...p, extractedText: text };
      }
      return p;
    }));
    setPreviewPage(prev => {
      if (prev && prev.id === id) {
        return { ...prev, extractedText: text };
      }
      return prev;
    });
  };

  const handleClearAll = () => {
    setShowClearConfirm(true);
  };

  const confirmClearAll = () => {
    setPages([]);
    setSourceFiles([]);
    setShowClearConfirm(false);
  };

  const handleExport = async () => {
    if (pages.length === 0) return;
    setIsProcessing(true);

    try {
      const mergedPdf = await PDFDocument.create();

      // Load all required source PDFs
      const neededSourceIds = new Set(pages.map(p => p.sourceFileId));
      const loadedSourceDocs: Record<string, PDFDocument> = {};

      for (const sourceId of Array.from(neededSourceIds) as string[]) {
        const sourceFile = sourceFiles.find(f => f.id === sourceId);
        if (sourceFile) {
          const arrayBuffer = await sourceFile.file.arrayBuffer();
          loadedSourceDocs[sourceId] = await PDFDocument.load(arrayBuffer);
        }
      }

      // Copy pages in the new order
      for (const pageMeta of pages) {
        const sourceDoc = loadedSourceDocs[pageMeta.sourceFileId];
        if (sourceDoc) {
          const [copiedPage] = await mergedPdf.copyPages(sourceDoc, [pageMeta.originalPageIndex]);
          if (pageMeta.rotation) {
            const currentRotation = copiedPage.getRotation().angle;
            copiedPage.setRotation(degrees(currentRotation + pageMeta.rotation));
          }

          if (pageMeta.annotationsImage) {
            const pngImage = await mergedPdf.embedPng(pageMeta.annotationsImage);
            // Get unrotated dimensions to draw correctly in the page's coordinate system
            const { width, height } = copiedPage.getSize();
            const rotation = copiedPage.getRotation().angle;
            
            // We need to draw the image so it covers the page.
            // Since the annotationsImage was created over the *already rotated* preview,
            // we need to draw it such that it appears upright when the page is viewed.
            // For simplicity, we can draw it with the page's logical width and height.
            // pdf-lib's drawImage origin is bottom-left.
            
            if (rotation === 0 || rotation === 360) {
              copiedPage.drawImage(pngImage, {
                x: 0,
                y: 0,
                width: width,
                height: height,
              });
            } else if (rotation === 90) {
              copiedPage.drawImage(pngImage, {
                x: 0,
                y: height,
                width: height,
                height: width,
                rotate: degrees(-90),
              });
            } else if (rotation === 180) {
              copiedPage.drawImage(pngImage, {
                x: width,
                y: height,
                width: width,
                height: height,
                rotate: degrees(-180),
              });
            } else if (rotation === 270) {
              copiedPage.drawImage(pngImage, {
                x: width,
                y: 0,
                width: height,
                height: width,
                rotate: degrees(-270),
              });
            }
          }

          mergedPdf.addPage(copiedPage);
        }
      }

      if (addPageNumbers) {
        const helveticaFont = await mergedPdf.embedFont(StandardFonts.Helvetica);
        const mergedPages = mergedPdf.getPages();
        mergedPages.forEach((page, idx) => {
          const { width } = page.getSize();
          const text = String(idx + 1);
          const textSize = 12;
          const textWidth = helveticaFont.widthOfTextAtSize(text, textSize);
          page.drawText(text, {
            x: width / 2 - textWidth / 2,
            y: 20,
            size: textSize,
            font: helveticaFont,
            color: rgb(0, 0, 0),
          });
        });
      }

      const pdfBytes = await mergedPdf.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `merged-document-${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("Error exporting PDF:", error);
      setAlertMessage("Failed to export PDF. The file might be corrupted or encrypted.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExportWord = async () => {
    if (pages.length === 0) return;
    setIsProcessing(true);

    try {
      const sections = [];
      const neededSourceIds = new Set(pages.map(p => p.sourceFileId));
      const loadedSourceDocs: Record<string, pdfjsLib.PDFDocumentProxy> = {};

      for (const sourceId of Array.from(neededSourceIds) as string[]) {
        const sourceFile = sourceFiles.find(f => f.id === sourceId);
        if (sourceFile) {
          const arrayBuffer = await sourceFile.file.arrayBuffer();
          loadedSourceDocs[sourceId] = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        }
      }

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      for (let i = 0; i < pages.length; i++) {
        const pageMeta = pages[i];
        const pdfDoc = loadedSourceDocs[pageMeta.sourceFileId];
        if (pdfDoc && context) {
          const page = await pdfDoc.getPage(pageMeta.originalPageIndex + 1);
          
          const renderScale = 2.0;
          const currentRotation = pageMeta.rotation || 0;
          const viewport = page.getViewport({ scale: renderScale, rotation: page.rotate + currentRotation });
          
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          await page.render({ canvasContext: context, canvas: canvas, viewport }).promise;

          if (pageMeta.annotationsImage) {
            const img = new Image();
            img.src = pageMeta.annotationsImage;
            await new Promise((resolve) => { img.onload = resolve; });
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
          }

          const base64Image = canvas.toDataURL('image/jpeg', 0.95);
          const response = await fetch(base64Image);
          const imageBuffer = await response.arrayBuffer();

          const displayViewport = page.getViewport({ scale: 1.0, rotation: page.rotate + currentRotation });

          sections.push({
            properties: {
              page: {
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                size: { 
                  width: displayViewport.width * 20,
                  height: displayViewport.height * 20 
                }
              }
            },
            children: [
              new Paragraph({
                children: [
                  new ImageRun({
                    data: imageBuffer,
                    transformation: {
                      width: displayViewport.width,
                      height: displayViewport.height,
                    },
                    type: 'jpg'
                  }),
                ],
              }),
            ],
          });
        }
      }

      const doc = new Document({
        sections: sections,
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `exported-document-${Date.now()}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("Error exporting to Word:", error);
      setAlertMessage("Failed to export to Word. The file might be corrupted or encrypted.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSummarizeDocument = async () => {
    if (pages.length === 0) return;
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      setAlertMessage("Gemini API key is not configured. Please add GEMINI_API_KEY to your environment variables.");
      return;
    }

    setIsSummarizing(true);
    setShowSummaryModal(true);
    
    try {
      // Extract text from all pages
      let fullText = "";
      const neededSourceIds = new Set(pages.map(p => p.sourceFileId));
      const loadedSourceDocs: Record<string, pdfjsLib.PDFDocumentProxy> = {};

      for (const sourceId of Array.from(neededSourceIds) as string[]) {
        const sourceFile = sourceFiles.find(f => f.id === sourceId);
        if (sourceFile) {
          const arrayBuffer = await sourceFile.file.arrayBuffer();
          loadedSourceDocs[sourceId] = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        }
      }

      for (let i = 0; i < pages.length; i++) {
        const pageMeta = pages[i];
        const pdfDoc = loadedSourceDocs[pageMeta.sourceFileId];
        if (pdfDoc) {
          const page = await pdfDoc.getPage(pageMeta.originalPageIndex + 1);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item: any) => item.str).join(" ");
          fullText += `--- Page ${i + 1} ---\n${pageText}\n\n`;
        }
        // Limit text to avoid token limits for very large PDFs in this demo
        if (fullText.length > 30000) break; 
      }

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Provide a comprehensive summary of the following PDF document content. Highlight key points, main themes, and any important conclusions. Use clear markdown formatting with headings and bullet points.\n\nDOCUMENT CONTENT:\n${fullText}`,
      });

      setDocSummary(response.text || "Could not generate summary.");
    } catch (error: any) {
      console.error("Error summarizing document:", error);
      setDocSummary("Failed to generate document summary. " + (error.message || ""));
    } finally {
      setIsSummarizing(false);
    }
  };

  const activePage = pages.find(p => p.id === activeId);

  return (
    <div className="bg-[#0f111a] text-white font-sans selection:bg-[#ff6d5a]/30">
      {/* Landing Page */}
      <section className="min-h-screen flex flex-col relative overflow-hidden">
        {/* Glowing Orb */}
        <motion.div 
          className="pointer-events-none absolute top-0 left-0 w-[600px] h-[600px] rounded-full bg-gradient-to-br from-[#ff6d5a]/40 via-[#ff4b33]/30 to-[#4b83f0]/40 blur-[120px] z-0 mix-blend-screen"
          style={{
            x: orbX,
            y: orbY,
          }}
        />
        
        {/* Navbar */}
        <nav className="h-16 border-b border-white/10 flex items-center justify-between px-6 relative z-10 bg-[#0f111a]/50 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6d5a] to-[#ff4b33] flex items-center justify-center shadow-lg shadow-[#ff6d5a]/20">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Nexus PDF</h1>
          </div>
          <div className="flex items-center gap-6 text-sm font-medium text-white/70">
            <button 
              onClick={() => document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth' })}
              className="hover:text-white transition-colors"
            >
              Workspace
            </button>
            <a href="#" className="hover:text-white transition-colors">Documentation</a>
            <button 
              onClick={() => document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth' })}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
            >
              Get Started
            </button>
          </div>
        </nav>

        {/* Hero */}
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="max-w-4xl mx-auto"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#ff6d5a]/10 border border-[#ff6d5a]/20 text-[#ff6d5a] text-sm font-medium mb-8">
              <Zap className="w-4 h-4" />
              <span>100% Local Processing</span>
            </div>
            <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-tight">
              Visual workflow automation <br/>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#ff6d5a] to-[#ff4b33]">
                for your PDFs
              </span>
            </h1>
            <p className="text-lg md:text-xl text-white/60 max-w-2xl mx-auto mb-10">
              Merge, reorder, and organize your PDF pages with a powerful node-like interface. 
              No cloud uploads, everything runs securely in your browser.
            </p>
            <div className="flex items-center justify-center gap-4">
              <button 
                onClick={() => document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth' })}
                className="px-8 py-4 bg-[#ff6d5a] hover:bg-[#ff5a45] text-white rounded-xl font-medium transition-all shadow-lg shadow-[#ff6d5a]/20 flex items-center gap-2 hover:scale-105 active:scale-95"
              >
                Open Workspace <ArrowDown className="w-5 h-5" />
              </button>
            </div>
          </motion.div>

          {/* Node Visual Mockup */}
          <motion.div 
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="mt-20 flex flex-col md:flex-row items-center justify-center gap-4 md:gap-8 opacity-90 scale-75 md:scale-100"
          >
            {/* Node 1 */}
            <div className="w-64 bg-[#1e2128] rounded-xl border border-white/10 shadow-2xl overflow-hidden text-left">
              <div className="h-2 bg-[#4b83f0]" />
              <div className="p-4 border-b border-white/5 flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-[#4b83f0]/20 flex items-center justify-center">
                  <UploadCloud className="w-4 h-4 text-[#4b83f0]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">File Trigger</div>
                  <div className="text-xs text-white/50">On PDF Upload</div>
                </div>
              </div>
              <div className="p-4 text-xs text-white/40 font-mono">
                Waiting for input...
              </div>
            </div>

            <ChevronRight className="w-8 h-8 text-white/20 rotate-90 md:rotate-0" />

            {/* Node 2 */}
            <div className="w-64 bg-[#1e2128] rounded-xl border border-white/10 shadow-2xl overflow-hidden text-left ring-2 ring-[#ff6d5a]/50">
              <div className="h-2 bg-[#ff6d5a]" />
              <div className="p-4 border-b border-white/5 flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-[#ff6d5a]/20 flex items-center justify-center">
                  <GripVertical className="w-4 h-4 text-[#ff6d5a]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">Page Reorder</div>
                  <div className="text-xs text-white/50">Visual Canvas</div>
                </div>
              </div>
              <div className="p-4 text-xs text-white/40 font-mono">
                Active workspace
              </div>
            </div>

            <ChevronRight className="w-8 h-8 text-white/20 rotate-90 md:rotate-0" />

            {/* Node 3 */}
            <div className="w-64 bg-[#1e2128] rounded-xl border border-white/10 shadow-2xl overflow-hidden text-left">
              <div className="h-2 bg-[#10b981]" />
              <div className="p-4 border-b border-white/5 flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-[#10b981]/20 flex items-center justify-center">
                  <FileDown className="w-4 h-4 text-[#10b981]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">Export PDF</div>
                  <div className="text-xs text-white/50">Merge & Download</div>
                </div>
              </div>
              <div className="p-4 text-xs text-white/40 font-mono">
                Ready to export
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Workspace */}
      <section id="workspace" className="min-h-screen py-12 px-4 md:px-8 flex flex-col items-center border-t border-white/10 relative bg-[#0f111a]">
        
        <div className="w-full max-w-7xl h-[85vh] min-h-[600px] bg-[#15171c] rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden relative z-10">
        {/* Header */}
        <motion.header 
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        className="h-16 border-b border-white/10 bg-[#1a1d24] flex items-center justify-between px-6 shrink-0 z-20"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6d5a] to-[#ff4b33] flex items-center justify-center shadow-lg shadow-[#ff6d5a]/20">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Nexus PDF</h1>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-white/80 cursor-pointer hover:text-white transition-colors select-none">
            <input 
              type="checkbox" 
              checked={addPageNumbers}
              onChange={(e) => setAddPageNumbers(e.target.checked)}
              className="w-4 h-4 rounded border-white/20 bg-white/5 text-[#ff6d5a] focus:ring-[#ff6d5a] focus:ring-offset-0 cursor-pointer accent-[#ff6d5a]"
            />
            Number Pages
          </label>
          
          <div className="w-px h-6 bg-white/10 mx-1" />

          {pages.length > 0 && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleClearAll}
              className="px-4 py-2 text-sm font-medium text-white/60 hover:text-white hover:bg-white/5 rounded-lg transition-colors flex items-center gap-2"
            >
              <X className="w-4 h-4" />
              Clear All
            </motion.button>
          )}
          
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="px-4 py-2 text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FilePlus2 className="w-4 h-4" />
            Add PDFs
          </motion.button>
          
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleSummarizeDocument}
            disabled={pages.length === 0 || isProcessing || isSummarizing}
            className="px-4 py-2 text-sm font-medium bg-[#ff6d5a]/10 hover:bg-[#ff6d5a]/20 text-[#ff6d5a] border border-[#ff6d5a]/30 rounded-lg transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSummarizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Summarize PDF
          </motion.button>
          
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleExportWord}
            disabled={pages.length === 0 || isProcessing}
            className="px-4 py-2 text-sm font-medium bg-[#4b83f0] hover:bg-[#3b6bce] text-white rounded-lg transition-all shadow-lg shadow-[#4b83f0]/20 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
          >
            {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            Export Word
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleExport}
            disabled={pages.length === 0 || isProcessing}
            className="px-5 py-2 text-sm font-medium bg-[#ff6d5a] hover:bg-[#ff5a45] text-white rounded-lg transition-all shadow-lg shadow-[#ff6d5a]/20 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
          >
            {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Merge & Export PDF
          </motion.button>
        </div>
      </motion.header>

      {/* Main Canvas Area */}
      <main className="flex-1 relative overflow-hidden flex flex-col">
        {/* n8n style dotted background */}
        <div 
          className="absolute inset-0 pointer-events-none opacity-20"
          style={{
            backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)',
            backgroundSize: '24px 24px'
          }}
        />

        {isProcessing && (
          <div className="absolute inset-0 z-50 bg-[#0f111a]/80 backdrop-blur-sm flex flex-col items-center justify-center">
            <Loader2 className="w-12 h-12 text-[#ff6d5a] animate-spin mb-4" />
            <p className="text-white/80 font-medium">Processing PDFs...</p>
          </div>
        )}

        {pages.length === 0 ? (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="flex-1 flex items-center justify-center z-10 p-6"
          >
            <div 
              className="max-w-md w-full bg-[#15171c] border border-white/10 border-dashed rounded-2xl p-12 flex flex-col items-center text-center transition-colors hover:border-[#ff6d5a]/50 hover:bg-[#1a1d24] cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <motion.div 
                animate={{ y: [0, -8, 0] }}
                transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
                className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-6"
              >
                <UploadCloud className="w-8 h-8 text-[#ff6d5a]" />
              </motion.div>
              <h2 className="text-xl font-semibold mb-2">Upload PDFs to Merge</h2>
              <p className="text-white/50 text-sm mb-8">
                Drag and drop your PDF files here, or click to browse. You can reorder the pages before exporting.
              </p>
              <button className="px-6 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-medium transition-colors">
                Select Files
              </button>
            </div>
          </motion.div>
        ) : (
          <div className="flex-1 overflow-y-auto p-8 z-10">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={pages.map((p) => p.id)}
                strategy={rectSortingStrategy}
              >
                <div className="flex flex-wrap gap-6 items-start justify-center max-w-7xl mx-auto">
                  {pages.map((page, index) => (
                    <SortablePage
                      key={page.id}
                      page={page}
                      index={index}
                      onRemove={handleRemovePage}
                      onPreview={setPreviewPage}
                    />
                  ))}
                </div>
              </SortableContext>

              {/* Drag Overlay for smooth visual feedback */}
              <DragOverlay zIndex={100}>
                {activeId && activePage ? (
                  <div className="relative flex flex-col bg-[#1e2128] rounded-xl border-2 border-[#ff6d5a] shadow-2xl overflow-hidden w-40 h-56 opacity-90 scale-105 rotate-2 cursor-grabbing">
                    <div className="flex-1 bg-white/5 p-2 flex items-center justify-center overflow-hidden">
                      <img
                        src={activePage.thumbnailDataUrl}
                        alt="Dragging page"
                        className="max-w-full max-h-full object-contain shadow-sm bg-white"
                        style={{ transform: `rotate(${activePage.rotation || 0}deg)` }}
                      />
                    </div>
                    <div className="h-10 px-3 bg-[#15171c] border-t border-white/5 flex items-center justify-between text-[10px] text-white/60 font-mono">
                      <div className="flex items-center gap-1.5">
                        <div className="w-4 h-4 rounded-full bg-[#ff6d5a] flex items-center justify-center text-white font-bold">
                          {pages.findIndex(p => p.id === activeId) + 1}
                        </div>
                      </div>
                      <div className="flex flex-col items-end truncate ml-2">
                        <span className="truncate w-full text-right">{activePage.sourceFileName}</span>
                      </div>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        )}

        {/* Preview Modal */}
        <AnimatePresence>
          {previewPage && (
            <PreviewModal 
              pageMeta={previewPage} 
              sourceFiles={sourceFiles} 
              onClose={() => setPreviewPage(null)} 
              onRotate={handleRotatePage}
              onDelete={handleRemovePage}
              onSaveAnnotations={handleSaveAnnotations}
              onSaveExtractedText={handleSaveExtractedText}
            />
          )}
        </AnimatePresence>

        {/* Summary Modal */}
        <AnimatePresence>
          {showSummaryModal && (
            <SummaryModal 
              summary={docSummary || ""} 
              loading={isSummarizing}
              onClose={() => setShowSummaryModal(false)}
              onRegenerate={handleSummarizeDocument}
            />
          )}
        </AnimatePresence>

        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
          multiple
          accept="application/pdf"
        />

        {/* Custom Confirm Modal */}
        <AnimatePresence>
          {showClearConfirm && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] bg-[#0f111a]/80 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div 
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="bg-[#1e2128] border border-white/10 rounded-xl shadow-2xl p-6 max-w-sm w-full flex flex-col gap-4"
              >
                <h3 className="text-lg font-semibold text-white">Clear All Pages</h3>
                <p className="text-white/70 text-sm">Are you sure you want to remove all pages? This action cannot be undone.</p>
                <div className="flex justify-end gap-3 mt-2">
                  <button 
                    onClick={() => setShowClearConfirm(false)}
                    className="px-4 py-2 text-sm font-medium text-white/70 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={confirmClearAll}
                    className="px-4 py-2 text-sm font-medium bg-red-500/80 hover:bg-red-500 text-white rounded-lg transition-colors"
                  >
                    Clear All
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Custom Alert Modal */}
        <AnimatePresence>
          {alertMessage && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] bg-[#0f111a]/80 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div 
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="bg-[#1e2128] border border-white/10 rounded-xl shadow-2xl p-6 max-w-sm w-full flex flex-col gap-4"
              >
                <h3 className="text-lg font-semibold text-white">Notice</h3>
                <p className="text-white/70 text-sm">{alertMessage}</p>
                <div className="flex justify-end mt-2">
                  <button 
                    onClick={() => setAlertMessage(null)}
                    className="px-4 py-2 text-sm font-medium bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
                  >
                    OK
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      </div>
      </section>

      {/* Footer */}
      <ReviewSection />
      <footer className="py-8 border-t border-white/10 bg-[#0f111a] text-center">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-white/50">
            <Layers className="w-4 h-4" />
            <span className="text-sm font-medium">Nexus PDF</span>
          </div>
          <p className="text-sm text-white/40">
            © {new Date().getFullYear()} Nexus PDF. All rights reserved. Local processing only.
          </p>
          <div className="flex items-center gap-4 text-sm text-white/40">
            <a href="#" className="hover:text-white transition-colors">Privacy</a>
            <a href="#" className="hover:text-white transition-colors">Terms</a>
            <a href="#" className="hover:text-white transition-colors">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
