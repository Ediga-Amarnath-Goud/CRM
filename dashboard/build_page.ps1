$p1 = @"
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Clock,
  Download,
  FileText,
  Flame,
  Hash,
  Inbox,
  Lock,
  Loader2,
  LogOut,
  Mail,
  Megaphone,
  MessageSquare,
  PauseCircle,
  Phone,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  User,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User as FirebaseUser,
} from "firebase/auth";
import { db } from "@/lib/firebase";
"@

[System.IO.File]::WriteAllText("c:\Users\amarn\Documents\CRM\dashboard\src\app\page.tsx", $p1, [System.Text.UTF8Encoding]::new($false))
Write-Host "p1 done"